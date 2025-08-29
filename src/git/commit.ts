import type { Octokit } from "@octokit/rest";
import type { Endpoints } from "@octokit/types";
import chalk from "chalk";
import { execSync } from "child_process";
import type { Ora } from "ora";
import { messages, spinners } from "../ui";
import { assertDefined } from "../util/assert";

interface GetLatestCommitFromBranchOptions {
    client: Octokit;
    owner: string;
    repo: string;
    branch: string;
    spinner: Ora;
}

interface GetAllCommitsFromPullRequestOptions {
    client: Octokit;
    owner: string;
    repo: string;
    pullNumber: number;
}

type Commit =
    Endpoints["GET /repos/{owner}/{repo}/commits/{ref}"]["response"]["data"];

interface CherryPickResult {
    success: boolean;
    newSha?: string;
    aborted?: boolean;
}

interface ConflictResolution {
    action: "continue" | "skip" | "abort";
}

const getAllCommitsFromPullRequest = async ({
    client,
    owner,
    repo,
    pullNumber,
}: GetAllCommitsFromPullRequestOptions) => {
    try {
        const response = await client.pulls.listCommits({
            owner,
            repo,
            pull_number: pullNumber,
        });

        return response.data;
    } catch (error) {
        throw error;
    }
};

const findCommitByMessage = (
    message: string,
    branch: string = "main",
): string | null => {
    try {
        const searchMessage = message.split("\n")[0];

        const result = execSync(
            `git log ${branch} --grep="${searchMessage.replace(/"/g, '\\"')}" --format="%H" -n 1`,
            { encoding: "utf8", stdio: "pipe" },
        ).trim();

        return result ?? null;
    } catch {
        return null;
    }
};

const executeCherryPick = (sha: string): string => {
    execSync(`git cherry-pick ${sha}`, {
        encoding: "utf8",
        stdio: "pipe",
    });
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
};

const handleMissingCommit = async (
    commit: Commit,
    spinner: Ora,
): Promise<{ found: boolean; alternativeSha?: string }> => {
    spinner.text = `Commit ${chalk.gray(commit.sha.slice(0, 7))} not found locally, fetching main branch...`;

    try {
        execSync(`git fetch origin main:main`, { stdio: "pipe" });

        const alternativeSha = findCommitByMessage(
            commit.commit.message,
            "main",
        );

        if (alternativeSha) {
            spinner.text = `Found commit with same message: ${chalk.yellow(alternativeSha.slice(0, 7))}`;
            return { found: true, alternativeSha };
        }

        spinner.fail(
            `Commit ${chalk.gray(commit.sha.slice(0, 7))} not found and no matching commit message found in main`,
        );
        console.log(
            chalk.yellow(
                "  This PR may have been squashed or merged differently.",
            ),
        );
        console.log(chalk.yellow("  Skipping this commit.\n"));
        return { found: false };
    } catch (fetchError) {
        spinner.fail(`Failed to fetch main branch: ${fetchError}`);
        return { found: false };
    }
};

const promptConflictResolution = async (): Promise<ConflictResolution> => {
    console.log(chalk.yellow("\n  📝 Please resolve conflicts in your editor"));
    console.log(chalk.cyan("     1. Fix the conflicted files"));
    console.log(chalk.cyan("     2. Save the files"));
    console.log(chalk.cyan("     3. Stage changes: git add ."));

    console.log(chalk.yellow("\n  Then press:"));
    console.log(chalk.green("     y - to continue after fixing conflicts"));
    console.log(chalk.yellow("     s - to skip this commit"));
    console.log(chalk.red("     q - to quit the process\n"));

    const readline = require("readline").createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const answer = await new Promise<string>((resolve) => {
        readline.question("  Your choice (y/s/q): ", (ans: string) => {
            readline.close();
            resolve(ans.toLowerCase());
        });
    });

    switch (answer) {
        case "y":
            return { action: "continue" };
        case "s":
            return { action: "skip" };
        case "q":
            return { action: "abort" };
        default:
            console.log(chalk.red("  ✗ Invalid choice. Defaulting to abort."));
            return { action: "abort" };
    }
};

const executeConflictResolution = async (
    resolution: ConflictResolution,
    commitSha: string,
): Promise<CherryPickResult> => {
    switch (resolution.action) {
        case "continue":
            try {
                execSync("git add .", { stdio: "pipe" });
                execSync("git cherry-pick --continue", { stdio: "pipe" });

                const newSha = execSync("git rev-parse HEAD", {
                    encoding: "utf8",
                }).trim();
                console.log(
                    chalk.green(
                        `  ✓ Resolved and committed ${chalk.gray(commitSha.slice(0, 7))} → ${chalk.green(newSha.slice(0, 7))}`,
                    ),
                );

                return { success: true, newSha };
            } catch {
                console.log(
                    chalk.red(
                        "  ✗ Failed to continue cherry-pick. Make sure all conflicts are resolved.",
                    ),
                );
                return { success: false };
            }

        case "skip":
            try {
                execSync("git cherry-pick --skip", { stdio: "pipe" });
                console.log(
                    chalk.yellow(
                        `  ⊘ Skipped commit ${chalk.gray(commitSha.slice(0, 7))}`,
                    ),
                );
                return { success: false };
            } catch {
                console.log(chalk.red("  ✗ Failed to skip cherry-pick"));
                return { success: false };
            }

        case "abort":
            try {
                execSync("git cherry-pick --abort", { stdio: "pipe" });
                console.log(chalk.red("  ✗ Cherry-pick process aborted"));
                return { success: false, aborted: true };
            } catch {
                console.log(chalk.red("  ✗ Failed to abort cherry-pick"));
                return { success: false, aborted: true };
            }
    }
};

const cherryPickCommit = async (commit: Commit): Promise<CherryPickResult> => {
    const spinner = spinners.cherryPick({ sha: commit.sha });
    spinner.start();

    let commitSha = commit.sha;
    let usedAlternateSha = false;

    try {
        const newSha = executeCherryPick(commitSha);

        spinner.succeed(
            `Cherry-picked ${chalk.gray(commitSha.slice(0, 7))} → ${chalk.green(newSha.slice(0, 7))}`,
        );

        return { success: true, newSha };
        // TODO: fix type
    } catch (error: any) {
        if (error.stderr && error.stderr.includes("bad object")) {
            const result = await handleMissingCommit(commit, spinner);

            if (!result.found) {
                return { success: false };
            }

            commitSha = assertDefined(
                result.alternativeSha,
                "Alternative SHA should be defined here",
            );
            usedAlternateSha = true;

            try {
                const newSha = executeCherryPick(commitSha);

                spinner.succeed(
                    `Cherry-picked ${chalk.gray(commit.sha.slice(0, 7))} → ${chalk.yellow(commitSha.slice(0, 7))} → ${chalk.green(newSha.slice(0, 7))}`,
                );

                return { success: true, newSha };
                // TODO: fix type
            } catch (retryError: any) {
                error = retryError;
            }
        }

        spinner.fail(
            `Failed to cherry-pick ${chalk.gray(commitSha.slice(0, 7))}${usedAlternateSha ? " (found by message)" : ""}: ${chalk.yellow("conflicts detected")}`,
        );

        const resolution = await promptConflictResolution();
        return executeConflictResolution(resolution, commitSha);
    }
};

export { getAllCommitsFromPullRequest, cherryPickCommit };
