# Piece CLI Reference

The `piece` executable has one stable result envelope and two configuration
schemas. Human results go to stderr; `--format json` emits exactly one
`schemaVersion: 1` result object on stdout. The result schema version is not
the same thing as the configuration schema version.

```text
piece analyze <entry> [options]  # schemaVersion 1 config
piece build [project] [options]  # schemaVersion 2 config
piece check [project] [options]  # schemaVersion 2 config
piece plan <build|check> [project] [options]  # schemaVersion 2, non-mutating
piece config validate [options]
piece doctor [project] [options]
```

`--workspace` defaults to the current directory and `--config` must name a
workspace-contained file named `piece.config.json`.

`--dry-run` is an alias for planning a `build` or `check`: it returns the same
non-mutating result shape as `piece plan`, with `requestedCommand` and
`dryRun: true`. Neither form starts a native command. `piece config validate`
parses the selected configuration and, for schema v2, checks every declared
project root and source root without analyzing sources or invoking a profile.

`piece doctor [project]` remains a capability report for schema v1. With a
schema v2 configuration, it also uses the non-mutating fallback planner for
each selected project's build and check profile. It verifies required markers
and the configured command under that profile's controlled `PATH`; a missing
wrapper, marker, package manager, or Go tool makes doctor exit `1`. Omitting a
project checks every configured project, so doctor does not require
`defaultProject`.

| Exit code | Meaning |
| --- | --- |
| `0` | The requested analysis or configured project task succeeded. |
| `1` | Analysis, a native task, dependency, or output proof failed. |
| `2` | Invalid arguments, configuration, project graph, or contained path. |
| `4` | Infrastructure could not read or resolve a required host resource. |

## Schema v1: single-file feedback

Schema v1 is available to `piece analyze` and `piece doctor`. Unknown keys are
rejected.

```json
{
  "schemaVersion": 1,
  "entry": "src/App.tsx",
  "sourceRoots": ["src"],
  "globals": ["console"],
  "packageScopeSelection": "safe",
  "sourceSetScopeSelection": "safe"
}
```

`entry` may instead be supplied after `analyze`. Schema v2 is intentionally
not silently interpreted as schema v1: use `build` or `check` for it.

## Schema v2: declared workspace tasks

Schema v2 never discovers projects. Each project must explicitly provide its
`id`, `root`, `sourceRoots`, `dependsOn`, `build`, and `check` task. IDs match
`[A-Za-z][A-Za-z0-9._-]*`, dependencies must name declared projects, and
declared dependency cycles are rejected before execution.

```json
{
  "schemaVersion": 2,
  "defaultProject": "web",
  "projects": [
    {
      "id": "shared",
      "root": "packages/shared",
      "sourceRoots": ["src"],
      "dependsOn": [],
      "build": {
        "request": { "profile": "typescript", "script": "build" },
        "policy": {
          "profiles": {
            "typescript": { "root": ".", "allowScripts": ["build"], "packageManager": "npm" }
          },
          "envAllowlist": ["PATH"]
        },
        "outputs": ["dist"]
      },
      "check": {
        "request": { "profile": "typescript", "script": "check" },
        "policy": {
          "profiles": {
            "typescript": { "root": ".", "allowScripts": ["check"], "packageManager": "npm" }
          },
          "envAllowlist": ["PATH"]
        }
      }
    },
    {
      "id": "web",
      "root": "apps/web",
      "sourceRoots": ["src"],
      "dependsOn": ["shared"],
      "build": {
        "request": { "profile": "typescript", "script": "build" },
        "policy": {
          "profiles": {
            "typescript": { "root": ".", "allowScripts": ["build"], "packageManager": "npm" }
          },
          "envAllowlist": ["PATH"]
        },
        "outputs": ["dist"]
      },
      "check": {
        "request": { "profile": "typescript", "script": "check" },
        "policy": {
          "profiles": {
            "typescript": { "root": ".", "allowScripts": ["check"], "packageManager": "npm" }
          },
          "envAllowlist": ["PATH"]
        }
      }
    }
  ]
}
```

`piece build` and `piece check` select `defaultProject` when no project ID is
given. Their selected dependency closure runs in dependency-first order. A
failed or blocked dependency skips its dependents. Piece re-analyzes the
declared workspace before each CLI task; a source-derived cross-project cycle
is reported and blocked rather than given an arbitrary execution order.

Project `root` and `sourceRoots` are relative to the workspace. Each task's
profile `root` and each declared build `outputs` entry are relative to that
project root. Paths must remain lexically and after realpath inside their
declared boundary. `outputs` is optional for a build. If present, every output
must exist as a file or directory after a successful command and resolve inside
the project; otherwise the build exits `1`. A successful build without
`outputs` is reported with `outputVerification: "not-configured"`, not as an
artifact proof.

### Planning a workspace task

`piece plan build [project]` and `piece plan check [project]` perform the same
workspace analysis and dependency-closure selection as execution. They then
validate each selected profile's strict allowlist and required marker, and
return the exact command, arguments, and working directory that would be used.
They never launch the command or verify build outputs. The JSON response has
`command: "plan"`, `task`, ordered `projects`, and batches annotated with
`parallelSafe`; it is suitable for CI approval or troubleshooting before a
real run.

## Strict native fallback profiles

The CLI forces `level: "project"`. Build/check force `mode: "execute"`; plan
and `--dry-run` force `mode: "plan"`. Configuration cannot add a shell command,
arbitrary arguments, an action runner, or a declaration extractor. Each task
policy declares exactly the selected profile:

| Profile | Request | Required markers | Allowlist |
| --- | --- | --- | --- |
| `go` | `{ "action": "build" }` or `{ "action": "test" }` | `go.mod` or `go.work` | `allowActions` containing `build`/`test` |
| `gradle` | `{ "task": "check" }` | `settings.gradle[.kts]` and the current-platform `gradlew` wrapper | `allowTasks` |
| `typescript` | `{ "script": "build" }` | `package.json` containing the script | `allowScripts`, optional `npm`/`pnpm`/`yarn` |

`policy.envAllowlist` must include `PATH` for execution. Add only the other
host variables a real tool needs (for example `HOME`, `TMPDIR`, `SystemRoot`,
or `USERPROFILE` on the applicable platform). Optional `policy.env` entries
must already be listed in that allowlist. Time, output, and termination-grace
limits are bounded by the fallback executor.

This is a constrained launcher, not a sandbox. An allowlisted Gradle task,
package script, or Go executable can run repository code. Treat schema v2
configuration, the selected toolchain on `PATH`, and checked-out project code
as trusted build inputs; do not put secrets in versioned policy environment
entries.

## Scope and cache boundary

The workspace graph uses only declared `dependsOn` edges plus relative imports
that resolve to declared workspace source files. Package-manager aliases,
unconfigured projects, and general monorepo discovery are out of scope. Native
project actions currently have cache status `bypass`: the CLI does not claim
cross-project artifact reuse or incremental compilation. Watch mode is not yet
available.
