import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Loader2, Mail, Webhook, Send, MessageSquare, Bell } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { api, type AlertChannel } from "../lib/api";

type ChannelKind = AlertChannel["channel"];

const CHANNEL_LABELS: Record<ChannelKind, string> = {
  email: "Email (Resend)",
  webhook: "Generic Webhook",
  telegram: "Telegram",
  slack: "Slack",
  ntfy: "ntfy",
};

const CHANNEL_ICONS: Record<ChannelKind, React.ReactNode> = {
  email: <Mail className="h-4 w-4" />,
  webhook: <Webhook className="h-4 w-4" />,
  telegram: <Send className="h-4 w-4" />,
  slack: <MessageSquare className="h-4 w-4" />,
  ntfy: <Bell className="h-4 w-4" />,
};

const CHANNEL_FIELDS: Record<ChannelKind, { key: string; label: string; type?: string; placeholder?: string }[]> = {
  email: [
    { key: "to", label: "To", type: "email", placeholder: "alerts@example.com" },
    { key: "from", label: "From", placeholder: "certpulse@example.com" },
  ],
  webhook: [
    { key: "url", label: "URL", placeholder: "https://example.com/hook" },
  ],
  telegram: [
    { key: "botToken", label: "Bot Token", placeholder: "123:abc…" },
    { key: "chatId", label: "Chat ID", placeholder: "-1001234567890" },
  ],
  slack: [
    { key: "url", label: "Incoming Webhook URL", placeholder: "https://hooks.slack.com/services/…" },
  ],
  ntfy: [
    { key: "topic", label: "Topic", placeholder: "certpulse-alerts" },
    { key: "server", label: "Server (optional)", placeholder: "https://ntfy.sh" },
  ],
};

function ConfigForm({
  channel,
  initial,
  onSubmit,
  onCancel,
  isPending,
}: {
  channel: ChannelKind;
  initial: Record<string, unknown>;
  onSubmit: (config: Record<string, unknown>) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const fields = CHANNEL_FIELDS[channel];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const f of fields) {
      const v = initial[f.key];
      out[f.key] = v === undefined || v === null ? "" : String(v);
    }
    return out;
  });

  return (
    <form
      className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const cfg: Record<string, unknown> = {};
        for (const f of fields) {
          const v = values[f.key]?.trim();
          if (v) cfg[f.key] = v;
        }
        onSubmit(cfg);
      }}
    >
      {fields.map((f) => (
        <label key={f.key} className="block text-xs text-slate-600">
          <span className="mb-1 block font-medium text-slate-700">{f.label}</span>
          <Input
            type={f.type ?? "text"}
            value={values[f.key] ?? ""}
            placeholder={f.placeholder}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            className="h-8 text-sm"
          />
        </label>
      ))}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
        </Button>
      </div>
    </form>
  );
}

export function ChannelsEditor({ domainId }: { domainId: number }) {
  const queryClient = useQueryClient();
  const channels = useQuery({
    queryKey: ["channels", domainId],
    queryFn: () => api.listChannels(domainId),
  });
  const [editing, setEditing] = useState<ChannelKind | null>(null);

  const upsert = useMutation({
    mutationFn: (args: { channel: ChannelKind; config: Record<string, unknown> }) =>
      api.upsertChannel(domainId, args.channel, { enabled: true, config: args.config }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["channels", domainId] });
      setEditing(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteChannel(domainId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels", domainId] }),
  });

  const allKinds: ChannelKind[] = ["email", "webhook", "telegram", "slack", "ntfy"];
  const configured = new Set((channels.data?.channels ?? []).map((c) => c.channel));
  const available = allKinds.filter((k) => !configured.has(k) || k === "email");

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Alert Channels</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {channels.isLoading && (
          <p className="text-sm text-slate-500">Loading…</p>
        )}
        {channels.data?.channels.length === 0 && (
          <p className="text-sm text-slate-500">
            No alert channels configured. Add one below.
          </p>
        )}
        <ul className="space-y-2">
          {channels.data?.channels.map((c) => (
            <li
              key={c.id || `${c.domainId}-${c.channel}`}
              className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                {CHANNEL_ICONS[c.channel]}
                <span className="font-medium text-slate-900">
                  {CHANNEL_LABELS[c.channel]}
                </span>
                <span className="text-slate-500">
                  {describeConfig(c)}
                </span>
                {!c.enabled && (
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                    disabled
                  </span>
                )}
              </div>
              {c.id !== 0 && (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Remove channel"
                  onClick={() => remove.mutate(c.id)}
                  disabled={remove.isPending}
                >
                  <Trash2 className="h-4 w-4 text-rose-500" />
                </Button>
              )}
            </li>
          ))}
        </ul>

        {available.length > 0 && (
          <div className="border-t border-slate-100 pt-3">
            {editing ? (
              <ConfigForm
                channel={editing}
                initial={{}}
                isPending={upsert.isPending}
                onCancel={() => setEditing(null)}
                onSubmit={(config) => upsert.mutate({ channel: editing, config })}
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                {available.map((k) => (
                  <Button
                    key={k}
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(k)}
                  >
                    <Plus className="h-3 w-3" />
                    {CHANNEL_LABELS[k]}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
        {upsert.error && (
          <p className="text-xs text-rose-600">
            Failed to save: {(upsert.error as Error).message}
          </p>
        )}
        <p className="pt-1 text-xs text-slate-500">
          Email falls back to console logging when no <code>RESEND_API_KEY</code> is set.
          {" "}
          The global <code>ALERT_EMAIL_TO</code> also creates a synthetic default-email
          channel per domain.
        </p>
      </CardContent>
    </Card>
  );
}

function describeConfig(c: AlertChannel): string {
  const cfg = c.config;
  // Safe getter: c.config is Record<string, unknown>, so we can't assume
  // any value is a string without a runtime check. These helpers avoid
  // unsafe `unknown` access in template strings.
  const getStr = (key: string): string | undefined => {
    const v = cfg[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  switch (c.channel) {
    case "email":
      return getStr("to") ? `→ ${getStr("to")}` : "default recipient";
    case "webhook":
      return getStr("url") ? `→ ${getStr("url")}` : "no URL";
    case "telegram":
      return getStr("chatId") ? `chat ${getStr("chatId")}` : "no chat id";
    case "slack":
      return getStr("url") ? "configured" : "no URL";
    case "ntfy":
      return getStr("topic") ? `topic ${getStr("topic")}` : "no topic";
  }
}
