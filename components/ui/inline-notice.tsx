import * as React from "react"
import { CircleCheck, CircleAlert, Info, TriangleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { cn } from "@/lib/utils"

type InlineNoticeProps = Omit<React.ComponentProps<typeof Alert>, "title"> & {
  title?: React.ReactNode
  icon?: React.ReactNode
  actions?: React.ReactNode
  descriptionClassName?: string
}

function InlineNotice({
  title,
  icon,
  actions,
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
      className={cn(
        actions && "sm:has-[>svg]:grid-cols-[1rem_minmax(0,1fr)_auto]",
        className,
      )}
      {...props}
    >
      {icon === undefined ? <Icon aria-hidden="true" /> : icon}
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {children ? (
        <AlertDescription className={cn(!title && "row-start-1", descriptionClassName)}>
          {children}
        </AlertDescription>
      ) : null}
      {actions ? (
        <div
          data-slot="alert-actions"
          className="col-start-2 mt-2 flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:col-start-3 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:self-center [&_a]:max-w-full [&_a]:whitespace-normal [&_a]:break-words [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:break-words max-sm:[&_a]:min-h-11 max-sm:[&_button]:min-h-11"
        >
          {actions}
        </div>
      ) : null}
    </Alert>
  )
}

export { InlineNotice }
export type { InlineNoticeProps }
