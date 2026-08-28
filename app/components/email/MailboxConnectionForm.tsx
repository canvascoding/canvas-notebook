"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type MailboxConnectionDraft = {
  emailAddress: string;
  displayName: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpPassword: string;
  imapEnabled: boolean;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  imapUsername: string;
  imapPassword: string;
};

export function MailboxConnectionForm({
  value,
  onChange,
  disabled = false,
  isEditing = false,
}: {
  value: MailboxConnectionDraft;
  onChange: (value: MailboxConnectionDraft) => void;
  disabled?: boolean;
  isEditing?: boolean;
}) {
  const t = useTranslations("settings.mailboxConnection");
  const [isSmtpAdvancedOpen, setIsSmtpAdvancedOpen] = useState(false);
  const [isImapAdvancedOpen, setIsImapAdvancedOpen] = useState(false);
  const update = <Key extends keyof MailboxConnectionDraft>(
    key: Key,
    nextValue: MailboxConnectionDraft[Key],
  ) => {
    onChange({ ...value, [key]: nextValue });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="mailbox-email-address">{t("emailAddress")}</Label>
          <Input
            id="mailbox-email-address"
            type="email"
            value={value.emailAddress}
            onChange={(event) => update("emailAddress", event.target.value)}
            placeholder="name@example.com"
            disabled={disabled}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mailbox-display-name">{t("displayName")}</Label>
          <Input
            id="mailbox-display-name"
            value={value.displayName}
            onChange={(event) => update("displayName", event.target.value)}
            placeholder={t("displayNamePlaceholder")}
            disabled={disabled}
          />
        </div>
      </div>

      <section className="space-y-4 rounded-lg border border-border bg-muted/20 p-4">
        <div>
          <h5 className="font-medium">{t("sendingTitle")}</h5>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("sendingDescription")}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="mailbox-smtp-host">{t("smtpHost")}</Label>
            <Input
              id="mailbox-smtp-host"
              className="font-mono text-xs"
              value={value.smtpHost}
              onChange={(event) => update("smtpHost", event.target.value)}
              placeholder="smtp.example.com"
              disabled={disabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mailbox-smtp-username">{t("username")}</Label>
            <Input
              id="mailbox-smtp-username"
              className="font-mono text-xs"
              value={value.smtpUsername}
              onChange={(event) => update("smtpUsername", event.target.value)}
              placeholder="name@example.com"
              disabled={disabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mailbox-smtp-password">{t("password")}</Label>
            <Input
              id="mailbox-smtp-password"
              type="password"
              className="font-mono text-xs"
              value={value.smtpPassword}
              onChange={(event) => update("smtpPassword", event.target.value)}
              placeholder={isEditing ? t("keepExistingPassword") : undefined}
              disabled={disabled}
            />
          </div>
        </div>
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setIsSmtpAdvancedOpen((current) => !current)}
          disabled={disabled}
          aria-expanded={isSmtpAdvancedOpen}
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${isSmtpAdvancedOpen ? "rotate-180" : ""}`}
          />
          {t("advancedSettings")}
        </button>
        {isSmtpAdvancedOpen && (
          <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="mailbox-smtp-port">{t("port")}</Label>
              <Input
                id="mailbox-smtp-port"
                inputMode="numeric"
                className="font-mono text-xs"
                value={value.smtpPort}
                onChange={(event) => update("smtpPort", event.target.value)}
                disabled={disabled}
              />
            </div>
            <label className="flex items-center gap-3 self-end rounded-md border border-border bg-background px-3 py-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={value.smtpSecure}
                onChange={(event) => update("smtpSecure", event.target.checked)}
                disabled={disabled}
                className="size-4 accent-primary"
              />
              {t("useEncryption")}
            </label>
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-lg border border-border bg-background p-4">
        <div>
          <h5 className="font-medium">{t("receivingTitle")}</h5>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {t("receivingDescription")}
          </p>
        </div>
        {value.imapEnabled && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="mailbox-imap-host">{t("imapHost")}</Label>
                <Input
                  id="mailbox-imap-host"
                  className="font-mono text-xs"
                  value={value.imapHost}
                  onChange={(event) => update("imapHost", event.target.value)}
                  placeholder="imap.example.com"
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mailbox-imap-username">{t("username")}</Label>
                <Input
                  id="mailbox-imap-username"
                  className="font-mono text-xs"
                  value={value.imapUsername}
                  onChange={(event) =>
                    update("imapUsername", event.target.value)
                  }
                  placeholder="name@example.com"
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mailbox-imap-password">{t("password")}</Label>
                <Input
                  id="mailbox-imap-password"
                  type="password"
                  className="font-mono text-xs"
                  value={value.imapPassword}
                  onChange={(event) =>
                    update("imapPassword", event.target.value)
                  }
                  placeholder={
                    isEditing ? t("keepExistingPassword") : undefined
                  }
                  disabled={disabled}
                />
              </div>
            </div>
            <button
              type="button"
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setIsImapAdvancedOpen((current) => !current)}
              disabled={disabled}
              aria-expanded={isImapAdvancedOpen}
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${isImapAdvancedOpen ? "rotate-180" : ""}`}
              />
              {t("advancedSettings")}
            </button>
            {isImapAdvancedOpen && (
              <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="mailbox-imap-port">{t("port")}</Label>
                  <Input
                    id="mailbox-imap-port"
                    inputMode="numeric"
                    className="font-mono text-xs"
                    value={value.imapPort}
                    onChange={(event) => update("imapPort", event.target.value)}
                    disabled={disabled}
                  />
                </div>
                <label className="flex items-center gap-3 self-end rounded-md border border-border bg-background px-3 py-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={value.imapSecure}
                    onChange={(event) =>
                      update("imapSecure", event.target.checked)
                    }
                    disabled={disabled}
                    className="size-4 accent-primary"
                  />
                  {t("useEncryption")}
                </label>
              </div>
            )}
          </div>
        )}
        <label className="flex items-center gap-3 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={!value.imapEnabled}
            onChange={(event) => update("imapEnabled", !event.target.checked)}
            disabled={disabled}
            className="size-4 accent-primary"
          />
          {t("sendOnly")}
        </label>
      </section>
    </div>
  );
}
