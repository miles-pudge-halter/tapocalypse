import { ChevronRight, Pencil, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { HubValidation } from "@/lib/api";
import { useHubStatus } from "@/lib/hooks";

export interface ShareState {
  share: boolean;
  /** Empty = use the key derived from the git remote. */
  hubKey: string;
  backfill: boolean;
}

const FORMAT_ERROR = "Use host/path in lowercase, for example github.com/acme/app or github.com/acme/app#apps/mobile.";

/** The copy for a hub-key problem: the server's text mapped to the form's wording where it knows the cause. */
function keyError(serverError: string | undefined, hub: HubValidation | null | undefined, hasKey: boolean): string | undefined {
  if (hub?.conflictWith) {
    return `“${hub.conflictWith.name}” on this machine already uses this key. Add a suffix such as #com.acme.kiosk so the two apps stay apart.`;
  }
  if (!serverError && hub && hub.derivedKey === null && !hasKey) return "Enter a key. This repository has no remote to derive one from.";
  if (!serverError) return undefined;
  if (/must look like/.test(serverError)) return FORMAT_ERROR;
  if (/same hub key/.test(serverError)) return "Another project on this machine already uses this key. Add a suffix such as #com.acme.kiosk so the two apps stay apart.";
  return serverError;
}

/** The "Share with team hub" block of the project form: opt-in checkbox, the hub project key, backfill, and what gets uploaded. */
export function ProjectShareField({
  projectId,
  value,
  onChange,
  hub,
  validating,
  serverError,
  wasShared,
  editing,
}: {
  projectId: string;
  value: ShareState;
  onChange(patch: Partial<ShareState>): void;
  /** The `hub` block of the latest validation; undefined until the first answer (or when the server sends none). */
  hub: HubValidation | null | undefined;
  validating: boolean;
  serverError: string | undefined;
  /** The saved project already has sharing on. */
  wasShared: boolean;
  editing: boolean;
}) {
  const { status, loading } = useHubStatus();
  const [changing, setChanging] = useState(false);
  const lastHub = useRef<HubValidation | null>(null);
  if (hub) lastHub.current = hub;
  const known = hub ?? lastHub.current;
  const configured = status?.configured === true;
  const host = (() => {
    try {
      return status?.url ? new URL(status.url).host : "the hub";
    } catch {
      return "the hub";
    }
  })();
  const derived = known?.derivedKey ?? null;
  const noRemote = known !== null && known.derivedKey === null;

  // Without a remote the key is not optional: start it at a key of its own, as the server's own hint suggests.
  useEffect(() => {
    if (value.share && noRemote && value.hubKey === "") onChange({ hubKey: `local/${projectId || "my-app"}` });
  }, [value.share, noRemote, value.hubKey, projectId, onChange]);

  const uploaded = known?.uploadedRuns ?? 0;
  const pending = (known?.existingRuns ?? 0) - uploaded;
  const showKeyInput = changing || value.hubKey !== "" || derived === null;
  const error = keyError(serverError, hub, value.hubKey !== "");

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start gap-3">
        <Checkbox
          id="pj-share"
          className="mt-0.5"
          checked={value.share}
          disabled={!configured}
          onCheckedChange={(v) => onChange({ share: v === true, ...(v === true && !wasShared ? { backfill: true } : {}) })}
          aria-describedby="pj-share-hint"
        />
        <div className="space-y-0.5">
          <Label htmlFor="pj-share" className="text-sm font-semibold">
            Share with team hub
          </Label>
          <p id="pj-share-hint" className="text-xs text-muted-foreground">
            {!configured ? (
              loading && !status ? (
                "Checking the team hub connection…"
              ) : (
                <>
                  Connect this machine to a team hub first.{" "}
                  <Button asChild variant="link" size="xs" className="h-auto p-0 text-xs">
                    <a href="#/setup?section=team-hub">Set up</a>
                  </Button>
                </>
              )
            ) : !value.share && wasShared && uploaded > 0 ? (
              `Uploads stop. The ${uploaded} runs already on the hub stay there until you remove them with tapocalypse hub unpublish --project ${projectId}.`
            ) : (
              `Finished runs of this project upload to ${host} automatically. Teammates and stakeholders can view them there; nothing can be started or changed from the hub.`
            )}
          </p>
        </div>
      </div>

      {value.share && (
        <div className="space-y-3 pl-7">
          {validating && !known ? (
            <Skeleton className="h-5 w-56" aria-label="Working out the hub project" />
          ) : (
            <Field
              id="pj-hubkey"
              label="Hub project"
              error={error}
              hint={
                showKeyInput
                  ? "Use the same key as your teammates. Lowercase host/path, plus #subpath for an app inside a monorepo."
                  : `Runs from teammates with the same key land in one hub project. Taken from the git remote “origin”${known?.subpath ? ` and the folder ${known.subpath}` : ""}.`
              }
            >
              {showKeyInput ? (
                <>
                  <Input
                    id="pj-hubkey"
                    className="font-mono"
                    spellCheck={false}
                    autoComplete="off"
                    value={value.hubKey}
                    placeholder={derived ?? "github.com/acme/app"}
                    onChange={(e) => onChange({ hubKey: e.target.value })}
                    aria-describedby="pj-hubkey-hint"
                    aria-invalid={error ? true : undefined}
                  />
                  {derived && (
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto p-0"
                      onClick={() => {
                        setChanging(false);
                        onChange({ hubKey: "" });
                      }}
                    >
                      Use {derived}
                    </Button>
                  )}
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{derived}</code>
                  <Button type="button" variant="ghost" size="xs" onClick={() => setChanging(true)}>
                    <Pencil />
                    Change
                  </Button>
                </div>
              )}
            </Field>
          )}

          {noRemote && value.hubKey.startsWith("local/") && (
            <div className="flex gap-2 rounded-md border border-orange-500/40 bg-orange-500/5 p-3 text-sm text-orange-700 dark:text-orange-300">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div>
                <p className="font-medium">This repository has no git remote</p>
                <p>
                  Its runs will go to a hub project of their own and will not merge with teammates' runs of the same app. Add the shared remote (git remote add origin …) and reopen this form, or enter the key your teammates use.
                </p>
              </div>
            </div>
          )}

          {editing && pending > 0 && (
            <div className="flex items-start gap-3">
              <Checkbox id="pj-backfill" className="mt-0.5" checked={value.backfill} onCheckedChange={(v) => onChange({ backfill: v === true })} aria-describedby="pj-backfill-hint" />
              <div className="space-y-0.5">
                <Label htmlFor="pj-backfill">Also upload the {pending} finished runs already on this machine</Label>
                <p id="pj-backfill-hint" className="text-xs text-muted-foreground">
                  Oldest first, one at a time. You can keep working while they upload.
                </p>
              </div>
            </div>
          )}

          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium underline-offset-4 hover:underline">
              <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
              What gets uploaded
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1 space-y-1 text-xs text-muted-foreground">
              <p>Uploaded: the run summary, checks, notes, model and cost, the report, the activity feed, and screenshots (as WebP unless you chose originals in Setup).</p>
              <p>
                Before upload, paths are rewritten (your home folder becomes ~, the repository becomes &lt;repo&gt;) and known secret formats are masked. Test-account emails in briefs and reports are uploaded as written.
              </p>
              <p>Never uploaded: raw agent events, session files, stderr, the run's MCP token, device serials.</p>
              <p>Deleting a run here does not delete it from the hub.</p>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
    </div>
  );
}
