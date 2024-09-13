# GitHub Team Sync Action

This GitHub Action automates the process of synchronizing team memberships and
repository access within a GitHub organization. It allows you to manage your GitHub
teams using configuration files, making it easier to maintain team structures as code.

## Features

- Create and update teams based on JSON configuration files
- Manage team memberships (add and remove members)
- Control repository access for teams
- Handle multiple team configurations in a single run
- Parallel processing for improved performance

## Usage

To use this action in your workflow, add the following step:

```yaml
- name: Sync GitHub Teams
  uses: your-github-username/github-team-sync-action@v1
  with:
    github-token: ${{ secrets.ORG_MANAGEMENT_TOKEN }}
    config-path: './teams'
    org-name: 'your-organization-name'
```

### Inputs

- `github-token` (required): A GitHub token with organization management permissions.
- `config-path` (required): The path to the directory containing your team configuration JSON files.
- `org-name` (required): The name of your GitHub organization.

## Configuration

Create JSON configuration files for each team you want to manage. Place these files in the directory specified by `config-path`.

Example configuration file (`teams/engineering.json`):

```json
{
  "name": "Engineering",
  "slug": "eng-team",
  "description": "Our awesome engineering team",
  "privacy": "closed",
  "members": [
    "developer1",
    "developer2",
    "developer3"
  ],
  "repositories": {
    "repo1": "admin",
    "repo2": "push",
    "frontend-*": "pull"
  }
}
```

### Configuration File Structure

- `name`: The display name of the team.
- `slug`: The team's slug (used in URLs).
- `description` (optional): A description of the team.
- `privacy` (optional): Either "secret" or "closed". Defaults to "closed" if not specified.
- `members`: An array of GitHub usernames to be included in the team.
- `repositories`: An object mapping repository names to permission levels. Use "*" for wildcards.

Permission levels: "pull", "push", "admin", "maintain", or "triage".

## Workflow Example

Here's an example of a complete workflow file (`.github/workflows/sync-teams.yml`):

```yaml
name: Sync GitHub Teams

on:
  push:
    paths:
      - 'teams/**/*.json'
  workflow_dispatch:

jobs:
  sync-teams:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Sync GitHub Teams
        uses: your-github-username/github-team-sync-action@v1
        with:
          github-token: ${{ secrets.ORG_MANAGEMENT_TOKEN }}
          config-path: './teams'
          org-name: 'your-organization-name'
```

This workflow will run whenever changes are pushed to JSON files in the `teams/` directory, or when manually triggered.

## Setup

1. Create a GitHub App with organization permissions or use a Personal Access Token with sufficient permissions.
2. Store the token as a secret in your repository (e.g., `ORG_MANAGEMENT_TOKEN`).
3. Create your team configuration JSON files and place them in the specified directory.
4. Set up the workflow file as shown in the example above.

## Error Handling

The action will attempt to process all configuration files, even if errors occur with individual files. Errors are logged but don't cause the entire action to fail unless there's a critical error.

## Limitations

- The action can only manage teams and repositories within a single organization per run.
- It requires appropriate permissions to manage teams and repository access.
- Wildcards in repository names only work for granting access, not for removing it.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
