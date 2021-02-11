// tslint:disable:no-console
import { Octokit } from '@octokit/rest';
import { green, yellow, red, cyan, bold, italic } from 'chalk';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { BaseReleaseTask } from './base-release-task';
import { promptAndGenerateChangelog } from './changelog';
import { CONFIG } from './config';
import { GitClient } from './git/git-client';
import { getGithubBranchCommitsUrl } from './git/github-urls';
import { promptForNewVersion } from './prompt/new-version-prompt';
import { parseVersionName, Version } from './version-name/parse-version';


/** Default filename for the changelog. */
export const CHANGELOG_FILE_NAME = 'CHANGELOG.md';


class StageReleaseCommitTask extends BaseReleaseTask {

    /** Path to the project package JSON. */
    packageJsonPath: string;

    /** Serialized package.json of the specified project. */
    packageJson: any;

    /** Parsed current version of the project. */
    currentVersion: Version;

    /** Instance of a wrapper that can execute Git commands. */
    git: GitClient;

    /** Octokit API instance that can be used to make Github API calls. */
    githubApi: Octokit;

    tabSpaces = 4;

    constructor(public projectDir: string,
                public repositoryOwner: string,
                public repositoryName: string) {

        super(new GitClient(projectDir,
            `https://github.com/${repositoryOwner}/${repositoryName}.git`));

        console.log(this.projectDir);

        this.packageJsonPath = join(projectDir, 'package.json');
        this.packageJson = JSON.parse(readFileSync(this.packageJsonPath, 'utf-8'));
        this.currentVersion = parseVersionName(this.packageJson.version);

        if (!this.currentVersion) {
            console.error(red(`Cannot parse current version in ${italic('package.json')}. Please ` +
                `make sure "${this.packageJson.version}" is a valid Semver version.`));
            process.exit(1);
        }

        this.githubApi = new Octokit({
            type: 'token',
            token: CONFIG.github.token
        });
    }

    async run() {
        console.log();
        console.log(cyan('-----------------------------------------'));
        console.log(cyan('  Mosaic stage release script'));
        console.log(cyan('-----------------------------------------'));
        console.log();

        const newVersion = await promptForNewVersion(this.currentVersion);
        const newVersionName = newVersion.format();
        const needsVersionBump = !newVersion.equals(this.currentVersion);

        // After the prompt for the new version, we print a new line because we want the
        // new log messages to be more in the foreground.
        console.log();

        // Ensure there are no uncommitted changes. Checking this before switching to a
        // publish branch is sufficient as unstaged changes are not specific to Git branches.
        this.verifyNoUncommittedChanges();

        const publishBranch = this.git.getCurrentBranch();

        this.verifyLocalCommitsMatchUpstream(publishBranch);
        await this.verifyPassingGithubStatus(publishBranch);

        if (needsVersionBump) {
            this.updatePackageJsonVersion(newVersionName);

            console.log(green(
                `  ✓   Updated the version to "${bold(newVersionName)}" inside of the ` +
                `${italic('package.json')}`));
            console.log();
        }

        await promptAndGenerateChangelog(join(this.projectDir, CHANGELOG_FILE_NAME));

        console.log();
        console.log(green(`  ✓   Updated the changelog in ` +
            `"${bold(CHANGELOG_FILE_NAME)}"`));
        console.log(yellow(`  ⚠   Please review CHANGELOG.md and ensure that the log contains only ` +
            `changes that apply to the public library release. When done, proceed to the prompt below.`));
        console.log();

        if (!await this.promptConfirm('Do you want to proceed and commit the changes?')) {
            console.log();
            console.log(yellow('Aborting release staging...'));
            process.exit(0);
        }

        this.git.stageAllChanges();
        this.git.createNewCommit(`chore: bump version to ${newVersionName} w/ changelog`);

        console.info();
        console.info(green(`  ✓   Created the staging commit for: "${newVersionName}".`));
        console.info(green(`  ✓   Please push the changes and submit a PR on GitHub.`));
        console.info();
    }

    /** Updates the version of the project package.json and writes the changes to disk. */
    private updatePackageJsonVersion(newVersionName: string) {
        const newPackageJson = {...this.packageJson, version: newVersionName};
        writeFileSync(this.packageJsonPath, `${JSON.stringify(newPackageJson, null, this.tabSpaces)}\n`);
    }

    /** Verifies that the latest commit of the current branch is passing all Github statuses. */
    private async verifyPassingGithubStatus(expectedPublishBranch: string) {
        const commitRef = this.git.getLocalCommitSha('HEAD');
        const githubCommitsUrl =
            getGithubBranchCommitsUrl(this.repositoryOwner, this.repositoryName, expectedPublishBranch);
        const {state} = (await this.githubApi.repos.getCombinedStatusForRef({
            owner: this.repositoryOwner,
            repo: this.repositoryName,
            ref: commitRef
        })).data;

        if (state === 'failure') {
            console.error(
                red(`  ✘   Cannot stage release. Commit "${commitRef}" does not pass all github ` +
                    `status checks. Please make sure this commit passes all checks before re-running.`));
            console.error(red(`      Please have a look at: ${githubCommitsUrl}`));

            if (await this.promptConfirm('Do you want to ignore the Github status and proceed?')) {
                console.info(green(
                    `  ⚠   Upstream commit is failing CI checks, but status has been ` +
                    `forcibly ignored.`));

                return;
            }
            process.exit(1);
        } else if (state === 'pending') {
            console.error(
                red(`  ✘   Commit "${commitRef}" still has pending github statuses that ` +
                    `need to succeed before staging a release.`));
            console.error(red(`      Please have a look at: ${githubCommitsUrl}`));

            if (await this.promptConfirm('Do you want to ignore the Github status and proceed?')) {
                console.info(green(
                    `  ⚠   Upstream commit is pending CI, but status has been ` +
                    `forcibly ignored.`));

                return;
            }
            process.exit(0);
        }

        console.info(green(`  ✓   Upstream commit is passing all github status checks.`));
    }
}

/** Entry-point for the release staging script. */
if (require.main === module) {
    new StageReleaseCommitTask(join(__dirname, '../../'), 'positive-js', 'mosaic').run();
}
