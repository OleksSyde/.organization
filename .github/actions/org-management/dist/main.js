"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const ajv_1 = __importDefault(require("ajv"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// Configuration schema
const configSchema = {
    type: 'object',
    properties: {
        name: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        privacy: { enum: ['secret', 'closed'] },
        repositories: {
            type: 'object',
            additionalProperties: { enum: ['pull', 'push', 'admin', 'maintain', 'triage'] }
        },
        members: { type: 'array', items: { type: 'string' } }
    },
    required: ['name', 'slug']
};
/**
 * Main function that runs the GitHub Action.
 * - Reads and validates configuration.
 * - Synchronizes team details (members and repositories).
 */
async function run() {
    try {
        const token = core.getInput('github-token', { required: true });
        const octokit = github.getOctokit(token);
        const configPath = core.getInput('config-path', { required: true });
        const orgName = core.getInput('org-name', { required: true });
        const changedFiles = await getChangedFiles();
        if (changedFiles.length > 0) {
            core.info(`Changed team configuration files: ${changedFiles.join(', ')}`);
        }
        else {
            core.info('No team configuration files were changed in this push');
        }
        // Read all JSON files in the directory
        const files = fs.readdirSync(configPath)
            .filter(file => file.endsWith('.json'))
            .map(file => path.join(configPath, file));
        for (const file of files) {
            core.info(`Processing file: ${file}`);
            const config = await getConfig(file);
            validateConfig(config);
            await syncTeam(octokit, orgName, config);
        }
        core.setOutput('result', 'Team synchronization completed successfully');
    }
    catch (error) {
        handleError(error);
    }
}
async function getChangedFiles() {
    const token = core.getInput('github-token', { required: true });
    const octokit = github.getOctokit(token);
    const push = github.context.payload.push;
    if (!push) {
        core.info('This is not a push event');
        return [];
    }
    const { before, after } = push;
    try {
        const response = await octokit.rest.repos.compareCommits({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            base: before,
            head: after,
        });
        const changedFiles = response.data.files?.map(file => file.filename) || [];
        // Filter for only .json files in the 'teams/' directory
        return changedFiles.filter(file => file.startsWith('teams/') && file.endsWith('.json'));
    }
    catch (error) {
        core.warning(`Failed to fetch changed files: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}
/**
 * Reads and parses the configuration file.
 * @param configPath - The path to the configuration file.
 * @returns The parsed configuration object.
 */
async function getConfig(configPath) {
    const fullPath = path.resolve(process.cwd(), configPath);
    const configContent = await fs.promises.readFile(fullPath, 'utf8');
    return JSON.parse(configContent);
}
/**
 * Validates the configuration object against the schema.
 * @param config - The configuration object to validate.
 * @throws Error if the configuration is invalid.
 */
function validateConfig(config) {
    const ajv = new ajv_1.default();
    const validate = ajv.compile(configSchema);
    if (!validate(config)) {
        throw new Error(`Invalid configuration: ${ajv.errorsText(validate.errors)}`);
    }
}
/**
 * Synchronizes the team by creating or updating it, and then syncing members and repositories.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param config - The configuration object for the team.
 */
async function syncTeam(octokit, orgName, config) {
    const team = await createOrUpdateTeam(octokit, orgName, config);
    core.info(`Team ${config.name} (ID: ${team.id}) synchronized`);
    await syncMembers(octokit, orgName, config.slug, config.members);
    await syncRepositories(octokit, orgName, config.slug, config.repositories);
}
/**
 * Creates or updates a team in the organization.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param config - The configuration object for the team.
 * @returns The team object containing the team ID.
 */
async function createOrUpdateTeam(octokit, orgName, config) {
    const team = await getTeam(octokit, orgName, config.slug);
    if (team) {
        return await updateTeam(octokit, orgName, config);
    }
    else {
        return await createTeam(octokit, orgName, config);
    }
}
/**
 * Retrieves a team by its slug.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team to retrieve.
 * @returns The team object if found, otherwise null.
 */
async function getTeam(octokit, orgName, teamSlug) {
    try {
        const { data: team } = await octokit.rest.teams.getByName({
            org: orgName,
            team_slug: teamSlug,
        });
        return team;
    }
    catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 404) {
            return null;
        }
        throw error;
    }
}
/**
 * Updates an existing team.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param config - The configuration object for the team.
 * @returns The updated team object.
 */
async function updateTeam(octokit, orgName, config) {
    const { data: updatedTeam } = await octokit.rest.teams.updateInOrg({
        org: orgName,
        team_slug: config.slug,
        name: config.name,
        description: config.description,
        privacy: config.privacy || 'closed',
    });
    core.info(`Team ${config.name} updated`);
    return updatedTeam;
}
/**
 * Creates a new team.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param config - The configuration object for the team.
 * @returns The newly created team object.
 */
async function createTeam(octokit, orgName, config) {
    const { data: newTeam } = await octokit.rest.teams.create({
        org: orgName,
        name: config.name,
        description: config.description,
        privacy: config.privacy || 'closed',
    });
    core.info(`Team ${config.name} created`);
    return newTeam;
}
/**
 * Synchronizes the members of a team.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @param configMembers - The list of members to synchronize with the team.
 */
async function syncMembers(octokit, orgName, teamSlug, configMembers) {
    const currentMembers = await getCurrentMembers(octokit, orgName, teamSlug);
    await addNewMembers(octokit, orgName, teamSlug, configMembers, currentMembers);
    await removeOldMembers(octokit, orgName, teamSlug, configMembers, currentMembers);
}
/**
 * Retrieves the current members of a team.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @returns The list of current team member logins.
 */
async function getCurrentMembers(octokit, orgName, teamSlug) {
    const { data: currentMembers } = await octokit.rest.teams.listMembersInOrg({
        org: orgName,
        team_slug: teamSlug,
    });
    return currentMembers.map(member => member.login);
}
/**
 * Adds members to a team if they are not already present.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @param configMembers - The list of members to add.
 * @param currentMembers - The list of current team members.
 */
async function addNewMembers(octokit, orgName, teamSlug, configMembers, currentMembers) {
    for (const member of configMembers) {
        if (!currentMembers.includes(member)) {
            try {
                await octokit.rest.teams.addOrUpdateMembershipForUserInOrg({
                    org: orgName,
                    team_slug: teamSlug,
                    username: member,
                });
                core.info(`Added ${member} to the team`);
            }
            catch (error) {
                core.warning(`Failed to add ${member}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}
/**
 * Removes members from a team if they are no longer in the configuration.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @param configMembers - The list of members to keep.
 * @param currentMembers - The list of current team members.
 */
async function removeOldMembers(octokit, orgName, teamSlug, configMembers, currentMembers) {
    for (const member of currentMembers) {
        if (!configMembers.includes(member)) {
            try {
                await octokit.rest.teams.removeMembershipForUserInOrg({
                    org: orgName,
                    team_slug: teamSlug,
                    username: member,
                });
                core.info(`Removed ${member} from the team`);
            }
            catch (error) {
                core.warning(`Failed to remove ${member}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}
/**
 * Synchronizes the repositories of a team.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @param configRepos - The repository access configuration.
 */
async function syncRepositories(octokit, orgName, teamSlug, configRepos) {
    const allRepos = await getAllRepos(octokit, orgName);
    const currentRepos = await getCurrentTeamRepos(octokit, orgName, teamSlug);
    const currentRepoNames = currentRepos.map(repo => repo.name);
    for (const repo of allRepos) {
        const repoName = repo.name;
        const { shouldHaveAccess, permission } = getRepoAccess(repoName, configRepos);
        if (shouldHaveAccess && permission) {
            if (!currentRepoNames.includes(repoName)) {
                await addRepoToTeam(octokit, orgName, teamSlug, repoName, permission);
            }
        }
        else if (currentRepoNames.includes(repoName)) {
            await removeRepoFromTeam(octokit, orgName, teamSlug, repoName);
        }
    }
}
/**
 * Retrieves all repositories in an organization.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @returns The list of all repositories.
 */
async function getAllRepos(octokit, orgName) {
    return await octokit.paginate(octokit.rest.repos.listForOrg, {
        org: orgName,
        per_page: 100,
    });
}
/**
 * Retrieves the current repositories of a team.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @returns The list of current team repositories.
 */
async function getCurrentTeamRepos(octokit, orgName, teamSlug) {
    const { data: currentRepos } = await octokit.rest.teams.listReposInOrg({
        org: orgName,
        team_slug: teamSlug,
    });
    return currentRepos;
}
/**
 * Determines if a repository should have access based on configuration.
 * @param repoName - The name of the repository.
 * @param configRepos - The repository access configuration.
 * @returns An object containing whether access should be granted and the permission level.
 */
function getRepoAccess(repoName, configRepos) {
    for (const [pattern, permission] of Object.entries(configRepos)) {
        if (matchRepoPattern(repoName, pattern)) {
            return { shouldHaveAccess: true, permission };
        }
    }
    return { shouldHaveAccess: false, permission: undefined };
}
/**
 * Matches a repository name against a pattern.
 * @param repoName - The name of the repository.
 * @param pattern - The pattern to match against.
 * @returns True if the repository name matches the pattern, otherwise false.
 */
function matchRepoPattern(repoName, pattern) {
    return pattern === '*' || (pattern.endsWith('*') && repoName.startsWith(pattern.slice(0, -1))) || repoName === pattern;
}
/**
 * Adds a repository to a team with specified permissions.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @param repoName - The name of the repository.
 * @param permission - The permission level to set.
 */
async function addRepoToTeam(octokit, orgName, teamSlug, repoName, permission) {
    await octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
        org: orgName,
        team_slug: teamSlug,
        owner: orgName,
        repo: repoName,
        permission: permission,
    });
    core.info(`Added ${repoName} to the team with ${permission} permission`);
}
/**
 * Removes a repository from a team.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @param repoName - The name of the repository.
 */
async function removeRepoFromTeam(octokit, orgName, teamSlug, repoName) {
    await octokit.rest.teams.removeRepoInOrg({
        org: orgName,
        team_slug: teamSlug,
        owner: orgName,
        repo: repoName,
    });
    core.info(`Removed ${repoName} from the team`);
}
/**
 * Handles errors by setting the action as failed and logging the error message.
 * @param error - The error object.
 */
function handleError(error) {
    if (error instanceof Error) {
        core.setFailed(error.message);
    }
    else {
        core.setFailed(String(error));
    }
}
run();
