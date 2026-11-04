import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useContext, type FormEvent, type ReactNode } from "react";

import { type FactoryAction, runFactoryAction } from "../../server/factory";
import { FactoryCompanion } from "./factory-companion";

interface FactoryFormProps {
  action: FactoryAction;
  /** The Outcome acted on; absent only for `create`. */
  id?: string;
  className?: string;
  children: ReactNode;
  "data-outcome-input"?: string;
}

/**
 * A board action as a form: its own fields (and the pressed button's name and value) are sent
 * through one validated server function, then the board refetches. The markup stays the form
 * the server-rendered board posted, so keyboard submission and field names are unchanged.
 */
export function FactoryForm({ action, id, className, children, ...rest }: FactoryFormProps) {
  const companion = useContext(FactoryCompanion);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (fields: Record<string, string>) =>
      runFactoryAction({ data: { companion, action, id, fields } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["factory", companion] }),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const fields: Record<string, string> = {};
    for (const [name, value] of new FormData(form, submitter)) {
      if (typeof value === "string") fields[name] = value;
    }
    mutation.mutate(fields, { onSuccess: () => form.reset() });
  };
  return (
    <form
      className={className}
      // Names the action as the server-rendered form's address did, e.g. `/acme-web/answer`.
      data-factory-action={id ? `/${id}/${action}` : `/${action}`}
      onSubmit={submit}
      aria-busy={mutation.isPending || undefined}
      {...rest}
    >
      <fieldset className="factory-form-fields" disabled={mutation.isPending}>
        {children}
      </fieldset>
      {mutation.error ? (
        <p className="factory-problems" role="alert">
          {mutation.error.message}
        </p>
      ) : null}
    </form>
  );
}
