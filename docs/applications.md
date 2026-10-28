# Portable applications

An agent can build a full application inside a permanent card and keep its
definition in the repository that owns that application. Other AgenticView
installations can import the same file through the settings card or an agent.

The versioned `.agenticview.json` file contains authored components, controls,
confirmation policies, logical connector bindings and initial card dimensions.
It contains no installed connector credentials, local binding values, invocation
history or automatically captured live telemetry.

Use the [JSON schema](../shared/application-manifest.schema.json) for editor and
tooling support. The [service-console example](../examples/applications/service-console.agenticview.json)
is a complete synthetic definition that can be committed to a repository. Its
handlers are integration contracts: configure the target worker before using it.

## Creating agent workflow

1. Build the card with the normal display/control tools. Mark it permanent using
   `card_configure` with an `application` descriptor.
2. Author a reusable manifest from the application's source configuration. Use
   logical binding names such as `service`, with the required handler names.
   Initialize dynamic data as empty rows/logs or configured paged sources.
3. Call `application_define(runId, runToken, manifest)`. This saves the authored
   template and marks the card permanent; it does not capture or replace its live
   components. Updating live components still uses `agent_publish`.
4. Call `application_export(runId, runToken)` and write that JSON to the creating
   project's repository, for example `apps/service-console.agenticview.json`.
   Commit the definition with the application code and document its handler
   contracts, dependencies and migration/version policy.

The creator writes to its own repository using its ordinary file/Git tools. The
hub does not receive repository credentials or write into an agent's checkout.
Review authored text, code and embeds before publishing: explicit template
content is source code, not an automatic secret scrubber. Never publish real
telemetry, production hostnames, share paths, database strings or credentials.
Keep private import identities and management credentials outside tracked files.

TypeScript callers can use `client.defineApplication(manifest)` followed by
`client.exportApplication()`. The returned JSON can be saved with normal file
tools. The schema and these APIs work independently of a specific database.

## Import manually

Open the bottom-left settings cog, choose **Applications**, and select or paste
the manifest. The preview shows its name/version, components, actions, permanence
and any custom executable views. Map each logical binding to a connector ID on
this installation, then choose **Import application**.

The card appears through normal live updates without changing camera zoom or
moving the selected card. Import does not execute commands or edits. Visible
configured read monitors start fetching data; trusted custom embeds may execute
when rendered under the installation's existing embed policy.

Installed definitions can be downloaded as JSON from the same section. Exports
use only the saved authored template, even if live components have since received
sensitive logs or rows. The local connector mapping remains on the installation.
These definition files complement compressed runtime archives; they serve
different purposes.
The library fetches at most 25 summaries per request and keeps only the current
page, so large application collections do not accumulate in the UI.

## Import through an agent

Call `application_import(manifest, bindings, requestId, registrationKey)` through
MCP. `bindings` maps logical names to local connector IDs, for example
`{"service":"worker-on-this-installation"}`. Keep a random 32+ character
`registrationKey` and the request ID private. Retry identical content and proof
after uncertain delivery; changed content with the same ID is rejected. A new
request imports a separate application instance.

The agent receives its private run credentials and current sequence so it can
manage the new card. TypeScript callers can use
`AgenticViewClient.importApplication(url, ingestionKey, manifest, bindings, identity)`.
Agent inbox consumers use these management credentials; imports performed through
the browser do not expose them in the UI or portable file.

HTTP equivalents:

| Operation | Endpoint and access |
| --- | --- |
| Save authored definition | `PUT /api/agents/{id}/application`, run token |
| Agent export | `GET /api/agents/{id}/application`, run token |
| List saved definitions | `GET /api/applications`, viewer |
| Download JSON | `GET /api/applications/{id}/export`, viewer |
| Import | `POST /api/applications/import`, viewer or ingestion key |

Import responses include run credentials only for the ingestion/MCP caller.
Viewer responses omit them. Export requires an explicitly saved definition;
it never falls back to packaging the card's current live contents.

## Environment and version boundaries

`schemaVersion` identifies the file format; `version` is the application's own
release version. Permanent cards survive disconnection, hub restart and optional
automatic cleanup. Explicit archive/restore still works. Exact import retries
preserve newer live content and saved templates rather than resetting the card.

Connector profiles, webhook URLs and secret environment references are installed
separately on the target machines. A repository can contain reviewed adapter
source and setup instructions, while each installation supplies its own private
profile. Importing a manifest does not install or launch those dependencies.
