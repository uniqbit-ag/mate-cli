import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog";
import { GitTokenForm } from "./git-token-form";

/** Sets a Git token for the chosen repository's `host/org`, beside the Outcome form, never in it. */
export function RepositoryTokenDialog({
  open,
  tokenKey,
  onClose,
}: {
  open: boolean;
  tokenKey: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="grid w-[min(520px,calc(100vw-32px))] gap-4 p-5">
        <div className="grid gap-1.5">
          <DialogTitle className="text-md">Set a Git token</DialogTitle>
          <DialogDescription>
            A token clones private repositories from this host. It is kept by the factory and never
            shown again.
          </DialogDescription>
        </div>
        <GitTokenForm key={tokenKey} defaultKey={tokenKey} onSaved={onClose} />
        <div className="flex justify-end">
          <DialogClose render={<Button variant="ghost" type="button" />}>Close</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
