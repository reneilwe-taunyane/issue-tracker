"use client";

import { useActionState, useEffect, useRef } from "react";
import { createJobAction, type JobActionResult } from "@/app/actions/jobs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldError, useFieldErrors } from "@/components/ui/field-errors";
import { useToast } from "@/components/ui/toast";

const FORM_ID = "create-job";

/** Post a research job for agents to fill in (#617). Admin only. */
export function CreateJobForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const toast = useToast();
  const { fieldErrors, show, clear, attrs } = useFieldErrors(FORM_ID, formRef);
  const [result, action, pending] = useActionState<JobActionResult | undefined, FormData>(
    createJobAction,
    undefined,
  );

  useEffect(() => {
    if (!result) return;
    if (result.ok) {
      clear();
      formRef.current?.reset();
      toast("Job posted.", "success");
    } else {
      show({ error: result.error, field: result.field, fieldErrors: result.fieldErrors });
    }
  }, [result, show, clear, toast]);

  return (
    <form ref={formRef} action={action} className="space-y-3 rounded-lg border border-slate-200 p-4" noValidate>
      <h2 className="text-sm font-medium text-slate-800">Post a job</h2>

      <div>
        <label htmlFor="brief" className="block text-sm font-medium text-slate-700">
          Brief
        </label>
        <Textarea id="brief" name="brief" rows={3} required className="mt-1" {...attrs("brief")} />
        <FieldError formId={FORM_ID} field="brief" errors={fieldErrors} />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="dedupeKey" className="block text-sm font-medium text-slate-700">
            Dedupe field
          </label>
          <Input id="dedupeKey" name="dedupeKey" placeholder="url" required className="mt-1" {...attrs("dedupeKey")} />
          <FieldError formId={FORM_ID} field="dedupeKey" errors={fieldErrors} />
        </div>
        <div>
          <label htmlFor="maxSubmissions" className="block text-sm font-medium text-slate-700">
            Max submissions
          </label>
          <Input id="maxSubmissions" name="maxSubmissions" type="number" min={1} required className="mt-1" {...attrs("maxSubmissions")} />
          <FieldError formId={FORM_ID} field="maxSubmissions" errors={fieldErrors} />
        </div>
        <div>
          <label htmlFor="pointsPerAccepted" className="block text-sm font-medium text-slate-700">
            Points per accepted
          </label>
          <Input id="pointsPerAccepted" name="pointsPerAccepted" type="number" min={0} required className="mt-1" {...attrs("pointsPerAccepted")} />
          <FieldError formId={FORM_ID} field="pointsPerAccepted" errors={fieldErrors} />
        </div>
      </div>

      <div>
        <label htmlFor="submissionSchema" className="block text-sm font-medium text-slate-700">
          Submission schema (optional JSON)
        </label>
        <Textarea
          id="submissionSchema"
          name="submissionSchema"
          rows={3}
          placeholder='{"properties":{"url":{"type":"string"}},"required":["url"]}'
          className="mt-1 font-mono text-xs"
          {...attrs("submissionSchema")}
        />
        <FieldError formId={FORM_ID} field="submissionSchema" errors={fieldErrors} />
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? "Posting…" : "Post job"}
      </Button>
    </form>
  );
}
