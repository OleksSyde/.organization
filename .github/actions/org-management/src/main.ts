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

/**
 * Main function that runs the GitHub Action.
 * - Reads and validates configuration.
 * - Synchronizes team details (members and repositories).
 */
async function run(): Promise<void> {
    try {
        const token = core.getInput('github-token', { required: true })
        const octokit = github.getOctokit(token)
        const configPath = core.getInput('config-path', { required: true })
        const orgName = core.getInput('org-name', { required: true })

        const config = await getConfig(configPath)
        validateConfig(config)

        await syncTeam(octokit, orgName, config)

        core.setOutput('result', 'Team synchronization completed successfully')
    } catch (error) {
        handleError(error)
    }
}

/**
 * Reads and parses the configuration file.
 * @param configPath - The path to the configuration file.
 * @returns The parsed configuration object.
 */
async function getConfig(configPath: string): Promise<TeamConfig> {
    const fullPath = path.resolve(process.cwd(), configPath)
    const configContent = await fs.promises.readFile(fullPath, 'utf8')
    return JSON.parse(configContent)
}

/**
 * Validates the configuration object against the schema.
 * @param config - The configuration object to validate.
 * @throws Error if the configuration is invalid.
 */
function validateConfig(config: any): asserts config is TeamConfig {
    const ajv = new Ajv()
    const validate = ajv.compile(configSchema)
    if (!validate(config)) {
        throw new Error(`Invalid configuration: ${ajv.errorsText(validate.errors)}`)
    }
}

/**
 * Synchronizes the team by creating or updating it, and then syncing members and repositories.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param config - The configuration object for the team.
 */
async function syncTeam(octokit: ReturnType<typeof github.getOctokit>, orgName: string, config: TeamConfig): Promise<void> {
    const team = await createOrUpdateTeam(octokit, orgName, config)
    core.info(`Team ${config.name} (ID: ${team.id}) synchronized`)

    await syncMembers(octokit, orgName, config.slug, config.members)
    await syncRepositories(octokit, orgName, config.slug, config.repositories)
}

/**
 * Creates or updates a team in the organization.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param config - The configuration object for the team.
 * @returns The team object containing the team ID.
 */
async function createOrUpdateTeam(octokit: ReturnType<typeof github.getOctokit>, orgName: string, config: TeamConfig): Promise<{ id: number }> {
    const team = await getTeam(octokit, orgName, config.slug)
    if (team) {
        return await updateTeam(octokit, orgName, config)
    } else {
        return await createTeam(octokit, orgName, config)
    }
}

/**
 * Retrieves a team by its slug.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team to retrieve.
 * @returns The team object if found, otherwise null.
 */
async function getTeam(octokit: ReturnType<typeof github.getOctokit>, orgName: string, teamSlug: string): Promise<{ id: number } | null> {
    try {
        const { data: team } = await octokit.rest.teams.getByName({
            org: orgName,
            team_slug: teamSlug,
        })
        return team
    } catch (error) {
        if (error instanceof Error && 'status' in error && (error as any).status === 404) {
            return null
        }
        throw error
    }
}

/**
 * Updates an existing team.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param config - The configuration object for the team.
 * @returns The updated team object.
 */
async function updateTeam(octokit: ReturnType<typeof github.getOctokit>, orgName: string, config: TeamConfig): Promise<{ id: number }> {
    const { data: updatedTeam } = await octokit.rest.teams.updateInOrg({
        org: orgName,
        team_slug: config.slug,
        name: config.name,
        description: config.description,
        privacy: config.privacy || 'closed',
    })
    core.info(`Team ${config.name} updated`)
    return updatedTeam
}

/**
 * Creates a new team.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param config - The configuration object for the team.
 * @returns The newly created team object.
 */
async function createTeam(octokit: ReturnType<typeof github.getOctokit>, orgName: string, config: TeamConfig): Promise<{ id: number }> {
    const { data: newTeam } = await octokit.rest.teams.create({
        org: orgName,
        name: config.name,
        description: config.description,
        privacy: config.privacy || 'closed',
    })
    core.info(`Team ${config.name} created`)
    return newTeam
}

/**
 * Synchronizes the members of a team.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @param configMembers - The list of members to synchronize with the team.
 */
async function syncMembers(octokit: ReturnType<typeof github.getOctokit>, orgName: string, teamSlug: string, configMembers: string[]): Promise<void> {
    const currentMembers = await getCurrentMembers(octokit, orgName, teamSlug)
    await addNewMembers(octokit, orgName, teamSlug, configMembers, currentMembers)
    await removeOldMembers(octokit, orgName, teamSlug, configMembers, currentMembers)
}

/**
 * Retrieves the current members of a team.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @returns The list of current team member logins.
 */
async function getCurrentMembers(octokit: ReturnType<typeof github.getOctokit>, orgName: string, teamSlug: string): Promise<string[]> {
    const { data: currentMembers } = await octokit.rest.teams.listMembersInOrg({
        org: orgName,
        team_slug: teamSlug,
    })
    return currentMembers.map(member => member.login)
}

/**
 * Adds members to a team if they are not already present.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @param configMembers - The list of members to add.
 * @param currentMembers - The list of current team members.
 */
async function addNewMembers(octokit: ReturnType<typeof github.getOctokit>, orgName: string, teamSlug: string, configMembers: string[], currentMembers: string[]): Promise<void> {
    for (const member of configMembers) {
        if (!currentMembers.includes(member)) {
            try {
                await octokit.rest.teams.addOrUpdateMembershipForUserInOrg({
                    org: orgName,
                    team_slug: teamSlug,
                    username: member,
                })
                core.info(`Added ${member} to the team`)
            } catch (error) {
                core.warning(`Failed to add ${member}: ${error instanceof Error ? error.message : String(error)}`)
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
async function removeOldMembers(octokit: ReturnType<typeof github.getOctokit>, orgName: string, teamSlug: string, configMembers: string[], currentMembers: string[]): Promise<void> {
    for (const member of currentMembers) {
        if (!configMembers.includes(member)) {
            try {
                await octokit.rest.teams.removeMembershipForUserInOrg({
                    org: orgName,
                    team_slug: teamSlug,
                    username: member,
                })
                core.info(`Removed ${member} from the team`)
            } catch (error) {
                core.warning(`Failed to remove ${member}: ${error instanceof Error ? error.message : String(error)}`)
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
async function syncRepositories(octokit: ReturnType<typeof github.getOctokit>, orgName: string, teamSlug: string, configRepos: Record<string, string>): Promise<void> {
    const allRepos = await getAllRepos(octokit, orgName)
    const currentRepos = await getCurrentTeamRepos(octokit, orgName, teamSlug)
    const currentRepoNames = currentRepos.map(repo => repo.name)

    for (const repo of allRepos) {
        const repoName = repo.name
        const { shouldHaveAccess, permission } = getRepoAccess(repoName, configRepos)

        if (shouldHaveAccess && permission) {
            if (!currentRepoNames.includes(repoName)) {
                await addRepoToTeam(octokit, orgName, teamSlug, repoName, permission)
            }
        } else if (currentRepoNames.includes(repoName)) {
            await removeRepoFromTeam(octokit, orgName, teamSlug, repoName)
        }
    }
}

/**
 * Retrieves all repositories in an organization.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @returns The list of all repositories.
 */
async function getAllRepos(octokit: ReturnType<typeof github.getOctokit>, orgName: string) {
    return await octokit.paginate(octokit.rest.repos.listForOrg, {
        org: orgName,
        per_page: 100,
    })
}

/**
 * Retrieves the current repositories of a team.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @returns The list of current team repositories.
 */
async function getCurrentTeamRepos(octokit: ReturnType<typeof github.getOctokit>, orgName: string, teamSlug: string) {
    const { data: currentRepos } = await octokit.rest.teams.listReposInOrg({
        org: orgName,
        team_slug: teamSlug,
    })
    return currentRepos
}

/**
 * Determines if a repository should have access based on configuration.
 * @param repoName - The name of the repository.
 * @param configRepos - The repository access configuration.
 * @returns An object containing whether access should be granted and the permission level.
 */
function getRepoAccess(repoName: string, configRepos: Record<string, string>) {
    for (const [pattern, permission] of Object.entries(configRepos)) {
        if (matchRepoPattern(repoName, pattern)) {
            return { shouldHaveAccess: true, permission }
        }
    }
    return { shouldHaveAccess: false, permission: undefined }
}

/**
 * Matches a repository name against a pattern.
 * @param repoName - The name of the repository.
 * @param pattern - The pattern to match against.
 * @returns True if the repository name matches the pattern, otherwise false.
 */
function matchRepoPattern(repoName: string, pattern: string): boolean {
    return pattern === '*' || (pattern.endsWith('*') && repoName.startsWith(pattern.slice(0, -1))) || repoName === pattern
}

/**
 * Adds a repository to a team with specified permissions.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @param repoName - The name of the repository.
 * @param permission - The permission level to set.
 */
async function addRepoToTeam(octokit: ReturnType<typeof github.getOctokit>, orgName: string, teamSlug: string, repoName: string, permission: string): Promise<void> {
    await octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
        org: orgName,
        team_slug: teamSlug,
        owner: orgName,
        repo: repoName,
        permission: permission,
    })
    core.info(`Added ${repoName} to the team with ${permission} permission`)
}

/**
 * Removes a repository from a team.
 * @param octokit - The Octokit instance for GitHub API interactions.
 * @param orgName - The name of the organization.
 * @param teamSlug - The slug of the team.
 * @param repoName - The name of the repository.
 */
async function removeRepoFromTeam(octokit: ReturnType<typeof github.getOctokit>, orgName: string, teamSlug: string, repoName: string): Promise<void> {
    await octokit.rest.teams.removeRepoInOrg({
        org: orgName,
        team_slug: teamSlug,
        owner: orgName,
        repo: repoName,
    })
    core.info(`Removed ${repoName} from the team`)
}

/**
 * Handles errors by setting the action as failed and logging the error message.
 * @param error - The error object.
 */
function handleError(error: unknown): void {
    if (error instanceof Error) {
        core.setFailed(error.message)
    } else {
        core.setFailed(String(error))
    }
}

run()
