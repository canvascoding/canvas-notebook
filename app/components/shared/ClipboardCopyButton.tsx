"use client";

import React from "react";
import { Check, ChevronDown, Copy, FileText } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  type ClipboardContent,
  type ClipboardCopyMode,
  writeClipboardContent,
} from "@/app/lib/clipboard/browser";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ClipboardCopyButtonProps = {
  content: ClipboardContent;
  className?: string;
  buttonClassName?: string;
  menuSide?: "top" | "right" | "bottom" | "left";
  tooltipSide?: "top" | "right" | "bottom" | "left";
  testId?: string;
};

export function ClipboardCopyButton({
  content,
  className,
  buttonClassName,
  menuSide = "bottom",
  tooltipSide = "top",
  testId,
}: ClipboardCopyButtonProps) {
  const t = useTranslations("chat");
  const [copyState, setCopyState] = React.useState<
    "idle" | "copied" | "failed"
  >("idle");
  const resetTimerRef = React.useRef<number | null>(null);
  const hasFormattedCopy = Boolean(content.html);
  const canCopy = content.plainText.length > 0;

  React.useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );

  const scheduleReset = React.useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(
      () => setCopyState("idle"),
      1_400,
    );
  }, []);

  const copy = React.useCallback(
    async (mode: ClipboardCopyMode) => {
      if (!canCopy) return;

      try {
        await writeClipboardContent(content, mode);
        setCopyState("copied");
      } catch {
        setCopyState("failed");
      }
      scheduleReset();
    },
    [canCopy, content, scheduleReset],
  );

  const copied = copyState === "copied";
  const copyLabel = copied
    ? t("copied")
    : copyState === "failed"
      ? t("copyFailed")
      : hasFormattedCopy
        ? t("copyFormatted")
        : t("copy");
  const CopyIcon = copied ? Check : Copy;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn("inline-flex items-center", className)}
        data-testid={testId}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                "h-7 w-7 border border-border/80 bg-background/95 text-muted-foreground shadow-sm transition hover:text-foreground",
                hasFormattedCopy && "rounded-r-none border-r-0",
                buttonClassName,
              )}
              onClick={() =>
                void copy(hasFormattedCopy ? "formatted" : "plain")
              }
              disabled={!canCopy}
              aria-label={copyLabel}
              title={copyLabel}
              data-testid={testId ? `${testId}-primary` : undefined}
            >
              <CopyIcon className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide} sideOffset={4}>
            {copyLabel}
          </TooltipContent>
        </Tooltip>
        {hasFormattedCopy ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-5 rounded-l-none border border-border/80 border-l-border/70 bg-background/95 px-0 text-muted-foreground shadow-sm transition hover:text-foreground",
                  buttonClassName,
                )}
                disabled={!canCopy}
                aria-label={t("copyOptions")}
                title={t("copyOptions")}
                data-testid={testId ? `${testId}-options` : undefined}
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side={menuSide}
              className="min-w-44"
            >
              <DropdownMenuItem onSelect={() => void copy("formatted")}>
                <Copy />
                {t("copyFormatted")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copy("plain")}>
                <FileText />
                {t("copyPlainText")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
