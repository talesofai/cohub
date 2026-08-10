import { HttpError, type CohubHttpClient, type Permission, type WorkCreateInput, type WorkMeta, type WorkStatus, type WorkTargetType, type WorkUpdateInput, type WorkViewStatsResponse, type WorkVisibility } from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { resolveSpace } from "../space.js";
import { downloadWork } from "../work-download.js";
import { getWorkByRef, parseWorkRef } from "../work-ref.js";
import { registerWorkCommerce } from "./work-commerce.js";

const WORK_STATUSES = ["published", "disabled"] as const;
const WORK_VISIBILITIES = ["public", "space"] as const;

const collectOption = (value: string, previous: string[] = []): string[] => [...previous, value];

function parseChoice<const T extends readonly string[]>(value: string, name: string, choices: T): T[number] {
  if ((choices as readonly string[]).includes(value)) return value as T[number];
  return error(`Invalid ${name}`, `Use one of: ${choices.join(", ")}`);
}

function parseJsonObject(value: string | undefined, name: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // handled below
  }
  return error(`Invalid ${name}`, `${name} must be a JSON object`);
}

function compactObject<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function withCohubBarMeta(input: {
  meta?: WorkMeta | null;
  hideCohubBar?: boolean;
  showCohubBar?: boolean;
}): WorkMeta | null | undefined {
  if (!input.hideCohubBar && !input.showCohubBar) return input.meta;
  const meta = input.meta ? { ...input.meta } : {};
  const presentation = meta.presentation && typeof meta.presentation === "object" && !Array.isArray(meta.presentation)
    ? { ...(meta.presentation as Record<string, unknown>) }
    : {};
  if (input.hideCohubBar) presentation.hideCohubBar = true;
  if (input.showCohubBar) delete presentation.hideCohubBar;
  if (Object.keys(presentation).length > 0) meta.presentation = presentation;
  else delete meta.presentation;
  return Object.keys(meta).length > 0 ? meta : null;
}

function resolveTarget(opts: { file?: string; dir?: string; port?: string }): { targetType: WorkTargetType; targetRef: string } | null {
  const targets = [
    opts.file ? { targetType: "file" as const, targetRef: opts.file } : null,
    opts.dir ? { targetType: "directory" as const, targetRef: opts.dir } : null,
    opts.port ? { targetType: "port" as const, targetRef: opts.port } : null,
  ].filter((target): target is { targetType: WorkTargetType; targetRef: string } => Boolean(target));
  if (targets.length === 0) return null;
  if (targets.length > 1) return error("Conflicting target", "Use only one of --file, --dir, or --port");
  return targets[0] ?? null;
}

function resolveStatus(opts: { disabled?: boolean; status?: string }): WorkStatus {
  const values = [opts.status, opts.disabled ? "disabled" : undefined].filter(Boolean);
  if (values.length > 1) return error("Conflicting status", "Use only one of --status or --disabled");
  return values[0] ? parseChoice(values[0], "status", WORK_STATUSES) : "published";
}

function resolveVisibility(value: string | undefined): WorkVisibility | undefined {
  return value ? parseChoice(value, "visibility", WORK_VISIBILITIES) : undefined;
}

function printWork(work: Record<string, unknown>): void {
  table([work], [
    { key: "id", label: "ID" },
    { key: "slug", label: "Slug" },
    { key: "status", label: "Status" },
    { key: "visibility", label: "Visibility" },
    { key: "targetType", label: "Target" },
    { key: "targetRef", label: "Ref" },
    { key: "latestVersion", label: "Version" },
    { key: "publishedAt", label: "Published" },
  ]);
}

function printWorkUrls(result: { publicUrl?: string | null; content?: { url: string } | null }): void {
  const lines = [
    result.publicUrl ? `Public URL: ${result.publicUrl}` : null,
    result.content?.url ? `Content URL: ${result.content.url}` : null,
  ].filter((line): line is string => Boolean(line));
  if (lines.length) console.log(`\n${lines.join("\n")}`);
}

function printWorkStats(stats: WorkViewStatsResponse): void {
  table([stats.summary], [
    { key: "totalViews", label: "Total" },
    { key: "views24h", label: "24h" },
    { key: "views7d", label: "7d" },
    { key: "views30d", label: "30d" },
  ]);
  if (stats.sources.length) {
    console.log("");
    table(stats.sources, [
      { key: "source", label: "Source" },
      { key: "views", label: "Views" },
    ]);
  }
}

export async function getWorkStatsByRef(client: CohubHttpClient, work: string): Promise<WorkViewStatsResponse> {
  const ref = parseWorkRef(work);
  if ("id" in ref) return client.works.getStats(ref.id);
  const detail = await getWorkByRef(client, work);
  return client.works.getStats(detail.work.id);
}

async function confirmDelete(opts: { yes?: boolean }): Promise<void> {
  if (opts.yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return error("Confirmation required", "Pass --yes to delete the work.");
  process.stdout.write("Deleting a work also removes its versions and viewer grants. Continue? [y/N] ");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    break;
  }
  const answer = Buffer.concat(chunks).toString().trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") return error("Cancelled");
}

async function publishWorkVersion(id: string, opts: { json?: boolean }): Promise<void> {
  const client = createClient();
  try {
    const result = await client.works.publishVersion(id);
    if (jsonRequested(opts)) return outJson(result);
    ok(`Work version updated: v${result.version.version}`);
    printWork(result.work);
  } catch (e: unknown) {
    handleHttp(e);
  }
}

type PublishOptions = {
  file?: string;
  dir?: string;
  port?: string;
  disabled?: boolean;
  status?: string;
  visibility?: string;
  workScope?: string[];
  viewerScope?: string[];
  meta?: string;
  hideCohubBar?: boolean;
  showCohubBar?: boolean;
  json?: boolean;
};

type UpdateOptions = PublishOptions & {
  slug?: string;
  clearWorkScopes?: boolean;
  clearViewerScopes?: boolean;
};

type ResolveOptions = {
  owner?: string;
  spaceSlug?: string;
  json?: boolean;
};

export function registerWorks(program: Command): void {
  const worksCmd = program.command("works").description("Work management");

  worksCmd
    .command("ls")
    .alias("list")
    .description("List works in the target space")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const spaceId = resolveSpace(worksCmd);
      const client = createClient();
      try {
        const result = await client.works.listBySpace(spaceId);
        if (jsonRequested(opts)) return outJson(result);
        table(result.works, [
          { key: "id", label: "ID" },
          { key: "slug", label: "Slug" },
          { key: "status", label: "Status" },
          { key: "visibility", label: "Visibility" },
          { key: "targetType", label: "Target" },
          { key: "targetRef", label: "Ref" },
          { key: "latestVersion", label: "Version" },
          { key: "publishedAt", label: "Published" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  worksCmd
    .command("get <work>")
    .description("Show work details by id, URL, mention URI, or username/space/work")
    .option("--json", "Output as JSON")
    .action(async (work: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const result = await getWorkByRef(client, work);
        if (jsonRequested(opts)) return outJson(result);
        printWork(result.work);
        printWorkUrls(result);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  worksCmd
    .command("stats <work>")
    .description("Show view statistics by id, URL, mention URI, or username/space/work")
    .option("--json", "Output as JSON")
    .action(async (work: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const result = await getWorkStatsByRef(client, work);
        if (jsonRequested(opts)) return outJson(result);
        printWorkStats(result);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  worksCmd
    .command("download <work>")
    .description("Download a published file or directory Work")
    .option("-o, --output <path>", "Output file or directory")
    .option("--json", "Output as JSON")
    .action(async (work: string, opts: { output?: string; json?: boolean }) => {
      const client = createClient();
      try {
        const detail = await getWorkByRef(client, work);
        const result = await downloadWork(detail, opts.output);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Downloaded ${result.files} file${result.files === 1 ? "" : "s"} to ${result.output}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  worksCmd
    .command("resolve <workSlug>")
    .description("Resolve a published work by owner and space slug")
    .option("--owner <username>", "Owner username")
    .option("--space-slug <slug>", "Space slug")
    .option("--json", "Output as JSON")
    .action(async (workSlug: string, opts: ResolveOptions) => {
      if (!opts.owner?.trim()) return error("Missing owner username", "Pass --owner <username>.");
      if (!opts.spaceSlug?.trim()) return error("Missing space slug", "Pass --space-slug <slug>.");
      const client = createClient();
      try {
        const result = await client.works.getBySlug(opts.owner.trim(), opts.spaceSlug.trim(), workSlug);
        if (jsonRequested(opts)) return outJson(result);
        printWork(result.work);
        printWorkUrls(result);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  worksCmd
    .command("publish <slug>")
    .description("Create or publish a work in the target space")
    .option("--file <path>", "Publish a file (HTML page, board, or any other file)")
    .option("--dir <path>", "Publish a directory site")
    .option("--port <port>", "Publish a public sandbox port")
    .option("--disabled", "Create as disabled")
    .option("--status <status>", "Work status: published, disabled")
    .option("--visibility <visibility>", "Work visibility: public, space")
    .option("--work-scope <scope>", "Scope granted to the work runtime (space.view, session.view, file.view, taskrun.view)", collectOption, [])
    .option("--viewer-scope <scope>", "Scope viewers may request (session.prompt.readonly, session.prompt.fullaccess, generation.create, user.space.list, user.session.list, user.usage.read)", collectOption, [])
    .option("--meta <json>", "Work metadata as a JSON object")
    .option("--hide-cohub-bar", "Hide the Cohub footer bar on the public work page")
    .option("--show-cohub-bar", "Show the Cohub footer bar on the public work page")
    .option("--json", "Output as JSON")
    .action(async (slug: string, opts: PublishOptions) => {
      if (opts.hideCohubBar && opts.showCohubBar) return error("Conflicting Cohub bar options", "Use either --hide-cohub-bar or --show-cohub-bar.");
      const target = resolveTarget(opts);
      if (!target) return error("Missing target", "Use one of --file, --dir, or --port.");
      const spaceId = resolveSpace(worksCmd);
      const client = createClient();
      const status = resolveStatus(opts);
      const meta = withCohubBarMeta({
        meta: parseJsonObject(opts.meta, "meta"),
        hideCohubBar: opts.hideCohubBar,
        showCohubBar: opts.showCohubBar,
      });
      const input: WorkCreateInput = {
        spaceId,
        slug,
        status,
        visibility: resolveVisibility(opts.visibility),
        targetType: target.targetType,
        targetRef: target.targetRef,
        workScopes: opts.workScope as Permission[],
        allowedViewerScopes: opts.viewerScope as Permission[],
        meta,
      };
      try {
        const result = await client.works.create(input);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Work published: ${result.work.id}`);
        printWork(result.work);
      } catch (e: unknown) {
        if (!(e instanceof HttpError) || e.status !== 409) handleHttp(e);
        try {
          const { works } = await client.works.listBySpace(spaceId);
          const existingWork = works.find((work) => work.slug === slug);
          if (!existingWork) return handleHttp(e);
          const { work } = await client.works.update(existingWork.id, {
            status: status === "published" && existingWork.status !== "published" ? existingWork.status : status,
            visibility: resolveVisibility(opts.visibility),
            targetType: target.targetType,
            targetRef: target.targetRef,
            workScopes: opts.workScope as Permission[],
            allowedViewerScopes: opts.viewerScope as Permission[],
            meta,
          });
          const publishedVersion = status === "published"
            ? await client.works.publishVersion(work.id)
            : null;
          const result = publishedVersion ?? { work };
          if (jsonRequested(opts)) return outJson(result);
          ok(status === "published" && publishedVersion ? `Work version updated: v${publishedVersion.version.version}` : `Work updated: ${work.id}`);
          printWork(result.work);
        } catch (fallbackError: unknown) {
          handleHttp(fallbackError);
        }
      }
    });

  worksCmd
    .command("update <id>")
    .description("Update work settings")
    .option("--slug <slug>", "New work slug")
    .option("--file <path>", "Use a file target (HTML page, board, or any other file)")
    .option("--dir <path>", "Use a directory site target")
    .option("--port <port>", "Use a public sandbox port target")
    .option("--disabled", "Set status to disabled")
    .option("--status <status>", "Work status: published, disabled")
    .option("--visibility <visibility>", "Work visibility: public, space")
    .option("--work-scope <scope>", "Scope granted to the work runtime (space.view, session.view, file.view, taskrun.view)", collectOption, [])
    .option("--viewer-scope <scope>", "Scope viewers may request (session.prompt.readonly, session.prompt.fullaccess, generation.create, user.space.list, user.session.list, user.usage.read)", collectOption, [])
    .option("--clear-work-scopes", "Clear work runtime scopes")
    .option("--clear-viewer-scopes", "Clear viewer-requestable scopes")
    .option("--meta <json>", "Work metadata as a JSON object")
    .option("--hide-cohub-bar", "Hide the Cohub footer bar on the public work page")
    .option("--show-cohub-bar", "Show the Cohub footer bar on the public work page")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: UpdateOptions) => {
      if (opts.hideCohubBar && opts.showCohubBar) return error("Conflicting Cohub bar options", "Use either --hide-cohub-bar or --show-cohub-bar.");
      const target = resolveTarget(opts);
      if (opts.clearWorkScopes && opts.workScope?.length) return error("Conflicting work scopes", "Use either --work-scope or --clear-work-scopes.");
      if (opts.clearViewerScopes && opts.viewerScope?.length) return error("Conflicting viewer scopes", "Use either --viewer-scope or --clear-viewer-scopes.");
      const hasMetaUpdate = opts.meta !== undefined || opts.hideCohubBar || opts.showCohubBar;
      const client = createClient();
      let meta: WorkMeta | null | undefined;
      if (hasMetaUpdate) {
        let baseMeta = opts.meta !== undefined ? parseJsonObject(opts.meta, "meta") ?? null : undefined;
        if (baseMeta === undefined && (opts.hideCohubBar || opts.showCohubBar)) {
          try {
            baseMeta = (await client.works.get(id)).work.meta;
          } catch (e: unknown) {
            handleHttp(e);
          }
        }
        meta = withCohubBarMeta({
          meta: baseMeta,
          hideCohubBar: opts.hideCohubBar,
          showCohubBar: opts.showCohubBar,
        });
      }
      const nextStatus = opts.status || opts.disabled ? resolveStatus(opts) : undefined;
      const currentWork = nextStatus === "published" ? (await client.works.get(id)).work : null;
      const input = compactObject<WorkUpdateInput>({
        slug: opts.slug,
        status: nextStatus === "published" && currentWork?.status !== "published" ? currentWork?.status : nextStatus,
        visibility: resolveVisibility(opts.visibility),
        targetType: target?.targetType,
        targetRef: target?.targetRef,
        workScopes: opts.clearWorkScopes ? [] : opts.workScope?.length ? opts.workScope as Permission[] : undefined,
        allowedViewerScopes: opts.clearViewerScopes ? [] : opts.viewerScope?.length ? opts.viewerScope as Permission[] : undefined,
        meta,
      });
      if (Object.keys(input).length === 0) return error("Nothing to update", "Pass --slug, --file, --dir, --port, --status, --visibility, --work-scope, --viewer-scope, --clear-work-scopes, --clear-viewer-scopes, --meta, --hide-cohub-bar, or --show-cohub-bar.");
      try {
        const updated = await client.works.update(id, input);
        const publishedVersion = nextStatus === "published" && currentWork?.status !== "published"
          ? await client.works.publishVersion(updated.work.id)
          : null;
        const result = publishedVersion ?? updated;
        if (jsonRequested(opts)) return outJson(result);
        ok(publishedVersion ? `Work published: v${publishedVersion.version.version}` : "Work updated");
        printWork(result.work);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  worksCmd
    .command("publish-version <id>")
    .description("Publish or update the current work version")
    .option("--json", "Output as JSON")
    .action(publishWorkVersion);

  worksCmd
    .command("release <id>", { hidden: true })
    .description("Deprecated alias for publish-version")
    .option("--json", "Output as JSON")
    .action(publishWorkVersion);

  worksCmd
    .command("versions <id>")
    .description("List work versions")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const result = await client.works.listVersions(id);
        if (jsonRequested(opts)) return outJson(result);
        table(result.versions, [
          { key: "version", label: "Version" },
          { key: "id", label: "ID" },
          { key: "targetType", label: "Target" },
          { key: "targetRef", label: "Ref" },
          { key: "createdAt", label: "Created" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  registerWorkCommerce(worksCmd);

  worksCmd
    .command("rm <id>")
    .alias("delete")
    .description("Delete a work")
    .option("-y, --yes", "Confirm deletion")
    .action(async (id: string, opts: { yes?: boolean }) => {
      await confirmDelete(opts);
      const client = createClient();
      try {
        await client.works.delete(id);
        ok("Work deleted");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
