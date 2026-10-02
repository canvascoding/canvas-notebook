import * as React from "react"
import { CircleCheck, CircleAlert, Info, TriangleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { cn } from "@/lib/utils"

type InlineNoticeProps = Omit<React.ComponentProps<typeof Alert>, "title"> & {
  title?: React.ReactNode
  icon?: React.ReactNode
  actions?: React.ReactNode
  actionLayout?: "responsive" | "stacked"
  descriptionClassName?: string
}

function InlineNotice({
  title,
  icon,
  actions,
  actionLayout = "responsive",
  children,
  variant = "default",
  size,
  className,
  descriptionClassName,
  ...props
}: InlineNoticeProps) {
  const Icon = variant === "destructive"
    ? CircleAlert
    : variant === "warning"
      ? TriangleAlert
      : variant === "success"
        ? CircleCheck
        : Info

  return (
    <Alert
      variant={variant}
      size={size}
      className={cn("@container/notice", className)}
      {...props}
    >
      {icon === undefined ? <Icon aria-hidden="true" /> : icon}
      <div
        data-slot="alert-content"
        className={cn(
          "col-start-2 row-start-1 grid min-w-0 gap-y-1",
          actions && actionLayout === "responsive" && "@min-[36rem]/notice:grid-cols-[minmax(0,1fr)_auto] @min-[36rem]/notice:gap-x-4",
        )}
      >
        {title ? <AlertTitle className="col-start-1">{title}</AlertTitle> : null}
        {children ? (
          <AlertDescription className={cn("col-start-1", title ? "row-start-2" : "row-start-1", descriptionClassName)}>
            {children}
          </AlertDescription>
        ) : null}
        {actions ? (
          <div
            data-slot="alert-actions"
            className={cn(
              "col-start-1 mt-2 flex min-w-0 max-w-full flex-wrap items-center gap-2 [&_a]:h-auto [&_a]:min-h-8 [&_a]:max-w-full [&_a]:py-1 [&_a]:whitespace-normal [&_a]:break-words [&_button]:h-auto [&_button]:min-h-8 [&_button]:max-w-full [&_button]:py-1 [&_button]:whitespace-normal [&_button]:break-words max-sm:[&_a]:min-h-11 max-sm:[&_button]:min-h-11",
              actionLayout === "responsive" && "@min-[36rem]/notice:col-start-2 @min-[36rem]/notice:row-span-2 @min-[36rem]/notice:row-start-1 @min-[36rem]/notice:mt-0 @min-[36rem]/notice:self-center",
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </Alert>
  )
}

export { InlineNotice }
export type { InlineNoticeProps }
