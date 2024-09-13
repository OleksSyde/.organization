import * as core from '@actions/core'
import * as github from '@actions/github'
import Ajv from 'ajv'
import * as fs from 'fs'
import * as path from 'path'

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
}

interface TeamConfig {
    name: string
    slug: string
    description?: string
    privacy?: 'secret' | 'closed'
    repositories: Record<string, 'pull' | 'push' | 'admin' | 'maintain' | 'triage'>
    members: string[]
}

async function run(): Promise<void> {
    try {
        const token = core.getInput('github-token', { required: true })
        const octokit = github.getOctokit(token)
        const configPath = core.getInput('config-path', { required: true })
        const orgName = core.getInput('org-name', { required: true })

        // Read and validate configuration
        const config = await readConfig(configPath)
        validateConfig(config)

        // Synchronize team
        await syncTeam(octokit, orgName, config)

        core.setOutput('result', 'Team synchronization completed successfully')
    } catch (error) {
        if (error instanceof Error) core.setFailed(error.message)
    }
}

async function readConfig(configPath: string): Promise<TeamConfig> {
    const fullPath = path.resolve(process.cwd(), configPath)
    const configContent = await fs.promises.readFile(fullPath, 'utf8')
    return JSON.parse(configContent)
}

function validateConfig(config: any): asserts config is TeamConfig {
    const ajv = new Ajv()
    const validate = ajv.compile(configSchema)
    if (!validate(config)) {
        throw new Error(`Invalid configuration: ${ajv.errorsText(validate.errors)}`)
    }
}

async function syncTeam(octokit: ReturnType<typeof github.getOctokit>, orgName: string, config: TeamConfig): Promise<void> {
    // Create or update team
    const team = await createOrUpdateTeam(octokit, orgName, config)
    core.info(`Team ${config.name} (ID: ${team.id}) synchronized`)

    // Sync team members
    await syncTeamMembers(octokit, orgName, team.id, config.members)

    // Sync team repositories
    await syncTeamRepositories(octokit, orgName, team.id, config.repositories)
}

async function createOrUpdateTeam(octokit: ReturnType<typeof github.getOctokit>, orgName: string, config: TeamConfig): Promise<{ id: number }> {
    try {
        // Try to get the team first
        const { data: existingTeam } = await octokit.rest.teams.getByName({
            org: orgName,
            team_slug: config.slug,
        })

        // Update existing team
        const { data: updatedTeam } = await octokit.rest.teams.updateInOrg({
            org: orgName,
            team_slug: config.slug,
            name: config.name,
            description: config.description,
            privacy: config.privacy || 'closed',
        })

        core.info(`Team ${config.name} updated`)
        return { id: updatedTeam.id }
    } catch (error) {
        if (error instanceof Error && 'status' in error && (error as any).status === 404) {
            // Team doesn't exist, create it
            const { data: newTeam } = await octokit.rest.teams.create({
                org: orgName,
                name: config.name,
                description: config.description,
                privacy: config.privacy || 'closed',
            })

            core.info(`Team ${config.name} created`)
            return { id: newTeam.id }
        }
        throw error
    }
}

async function syncTeamMembers(octokit: ReturnType<typeof github.getOctokit>, orgName: string, teamId: number, configMembers: string[]): Promise<void> {
    try {
        // Get current team members
        const { data: currentMembers } = await octokit.rest.teams.listMembersInOrg({
            org: orgName,
            team_slug: teamId.toString(),
        });

        const currentMemberLogins = currentMembers.map(member => member.login);

        core.info(`Current team members: ${currentMemberLogins.join(', ')}`);
        core.info(`Configured members: ${configMembers.join(', ')}`);

        // Add new members
        for (const member of configMembers) {
            if (!currentMemberLogins.includes(member)) {
                try {
                    await octokit.rest.teams.addOrUpdateMembershipForUserInOrg({
                        org: orgName,
                        team_slug: teamId.toString(),
                        username: member,
                    });
                    core.info(`Added ${member} to the team`);
                } catch (error) {
                    core.warning(`Failed to add ${member} to the team: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }

        // Remove members not in config
        for (const member of currentMemberLogins) {
            if (!configMembers.includes(member)) {
                try {
                    await octokit.rest.teams.removeMembershipForUserInOrg({
                        org: orgName,
                        team_slug: teamId.toString(),
                        username: member,
                    });
                    core.info(`Removed ${member} from the team`);
                } catch (error) {
                    core.warning(`Failed to remove ${member} from the team: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    } catch (error) {
        core.error(`Error synchronizing team members: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

async function syncTeamRepositories(octokit: ReturnType<typeof github.getOctokit>, orgName: string, teamId: number, configRepos: Record<string, string>): Promise<void> {
    // Get all repositories in the organization
    const allRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
        org: orgName,
        per_page: 100,
    })

    // Get current team repositories
    const { data: currentRepos } = await octokit.rest.teams.listReposInOrg({
        org: orgName,
        team_slug: teamId.toString(),
    })

    const currentRepoNames = currentRepos.map(repo => repo.name)

    for (const repo of allRepos) {
        const repoName = repo.name
        let shouldHaveAccess = false
        let permission: string | undefined

        // Check if repo matches any pattern in configRepos
        for (const [pattern, perm] of Object.entries(configRepos)) {
            if (matchRepoPattern(repoName, pattern)) {
                shouldHaveAccess = true
                permission = perm
                break
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
                })
                core.info(`Added ${repoName} to the team with ${permission} permission`)
            }
        } else if (currentRepoNames.includes(repoName)) {
            // Remove repo from team
            await octokit.rest.teams.removeRepoInOrg({
                org: orgName,
                team_slug: teamId.toString(),
                owner: orgName,
                repo: repoName,
            })
            core.info(`Removed ${repoName} from the team`)
        }
    }
}

function matchRepoPattern(repoName: string, pattern: string): boolean {
    if (pattern === '*') return true
    if (pattern.endsWith('*')) {
        return repoName.startsWith(pattern.slice(0, -1))
    }
    return repoName === pattern
}

run()
