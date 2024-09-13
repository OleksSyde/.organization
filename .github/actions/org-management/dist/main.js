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
async function run() {
    try {
        const token = core.getInput('github-token', { required: true });
        const octokit = github.getOctokit(token);
        const configPath = core.getInput('config-path', { required: true });
        const orgName = core.getInput('org-name', { required: true });
        // Read and validate configuration
        const config = await readConfig(configPath);
        validateConfig(config);
        // Synchronize team
        await syncTeam(octokit, orgName, config);
        core.setOutput('result', 'Team synchronization completed successfully');
    }
    catch (error) {
        if (error instanceof Error)
            core.setFailed(error.message);
    }
}
async function readConfig(configPath) {
    const fullPath = path.resolve(process.cwd(), configPath);
    const configContent = await fs.promises.readFile(fullPath, 'utf8');
    return JSON.parse(configContent);
}
function validateConfig(config) {
    const ajv = new ajv_1.default();
    const validate = ajv.compile(configSchema);
    if (!validate(config)) {
        throw new Error(`Invalid configuration: ${ajv.errorsText(validate.errors)}`);
    }
}
async function syncTeam(octokit, orgName, config) {
    // Create or update team
    const team = await createOrUpdateTeam(octokit, orgName, config);
    core.info(`Team ${config.name} (ID: ${team.id}) synchronized`);
    // Sync team members
    await syncTeamMembers(octokit, orgName, team.id, config.members);
    // Sync team repositories
    await syncTeamRepositories(octokit, orgName, team.id, config.repositories);
}
async function createOrUpdateTeam(octokit, orgName, config) {
    try {
        // Try to get the team first
        const { data: existingTeam } = await octokit.rest.teams.getByName({
            org: orgName,
            team_slug: config.slug,
        });
        // Update existing team
        const { data: updatedTeam } = await octokit.rest.teams.updateInOrg({
            org: orgName,
            team_slug: config.slug,
            name: config.name,
            description: config.description,
            privacy: config.privacy || 'closed',
        });
        core.info(`Team ${config.name} updated`);
        return { id: updatedTeam.id };
    }
    catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 404) {
            // Team doesn't exist, create it
            const { data: newTeam } = await octokit.rest.teams.create({
                org: orgName,
                name: config.name,
                description: config.description,
                privacy: config.privacy || 'closed',
            });
            core.info(`Team ${config.name} created`);
            return { id: newTeam.id };
        }
        throw error;
    }
}
async function syncTeamMembers(octokit, orgName, teamId, configMembers) {
    // Get current team members
    const { data: currentMembers } = await octokit.rest.teams.listMembersInOrg({
        org: orgName,
        team_slug: teamId.toString(),
    });
    const currentMemberLogins = currentMembers.map(member => member.login);
    // Add new members
    for (const member of configMembers) {
        if (!currentMemberLogins.includes(member)) {
            await octokit.rest.teams.addOrUpdateMembershipForUserInOrg({
                org: orgName,
                team_slug: teamId.toString(),
                username: member,
            });
            core.info(`Added ${member} to the team`);
        }
    }
    // Remove members not in config
    for (const member of currentMemberLogins) {
        if (!configMembers.includes(member)) {
            await octokit.rest.teams.removeMembershipForUserInOrg({
                org: orgName,
                team_slug: teamId.toString(),
                username: member,
            });
            core.info(`Removed ${member} from the team`);
        }
    }
}
async function syncTeamRepositories(octokit, orgName, teamId, configRepos) {
    // Get all repositories in the organization
    const allRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
        org: orgName,
        per_page: 100,
    });
    // Get current team repositories
    const { data: currentRepos } = await octokit.rest.teams.listReposInOrg({
        org: orgName,
        team_slug: teamId.toString(),
    });
    const currentRepoNames = currentRepos.map(repo => repo.name);
    for (const repo of allRepos) {
        const repoName = repo.name;
        let shouldHaveAccess = false;
        let permission;
        // Check if repo matches any pattern in configRepos
        for (const [pattern, perm] of Object.entries(configRepos)) {
            if (matchRepoPattern(repoName, pattern)) {
                shouldHaveAccess = true;
                permission = perm;
                break;
            }
        }
        if (shouldHaveAccess && permission) {
            if (!currentRepoNames.includes(repoName)) {
                // Add repo to team
                await octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
                    org: orgName,
                    team_slug: teamId.toString(),
                    owner: orgName,
                    repo: repoName,
                    permission: permission,
                });
                core.info(`Added ${repoName} to the team with ${permission} permission`);
            }
        }
        else if (currentRepoNames.includes(repoName)) {
            // Remove repo from team
            await octokit.rest.teams.removeRepoInOrg({
                org: orgName,
                team_slug: teamId.toString(),
                owner: orgName,
                repo: repoName,
            });
            core.info(`Removed ${repoName} from the team`);
        }
    }
}
function matchRepoPattern(repoName, pattern) {
    if (pattern === '*')
        return true;
    if (pattern.endsWith('*')) {
        return repoName.startsWith(pattern.slice(0, -1));
    }
    return repoName === pattern;
}
run();
