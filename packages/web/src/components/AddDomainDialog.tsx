import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { api } from "../lib/api";

interface AddDomainDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: (id: number) => void;
}

export function AddDomainDialog({ open, onOpenChange, onAdded }: AddDomainDialogProps) {
  const [hostname, setHostname] = React.useState("");
  const [port, setPort] = React.useState("443");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      const p = parseInt(port, 10);
      return api.addDomain(hostname.trim(), Number.isNaN(p) ? 443 : p);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      onAdded?.(data.domain.id);
      setHostname("");
      setPort("443");
      onOpenChange(false);
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hostname.trim()) return;
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle>Add Domain</DialogTitle>
        <DialogDescription>
          Add a hostname to monitor. The first SSL check runs immediately.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={onSubmit}>
        <DialogContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="hostname">Hostname</Label>
            <Input
              id="hostname"
              autoFocus
              placeholder="example.com"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="port">Port</Label>
            <Input
              id="port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
          {mutation.isError && (
            <p className="text-sm text-red-600">
              {(mutation.error as Error).message}
            </p>
          )}
        </DialogContent>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending || !hostname.trim()}>
            {mutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Add &amp; Check Now
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
