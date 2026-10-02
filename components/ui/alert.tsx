import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const alertVariants = cva(
  "relative grid min-w-0 w-full grid-cols-[0_minmax(0,1fr)] items-start gap-y-1 rounded-md border text-sm text-foreground has-[>svg]:grid-cols-[1rem_minmax(0,1fr)] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:translate-y-0.5",
  {
    variants: {
      variant: {
        default: "border-border bg-card [&>svg]:text-muted-foreground",
        info: "border-primary/25 bg-background [&>svg]:text-primary",
        warning: "border-warning/30 bg-background [&>svg]:text-warning",
        success: "border-success/30 bg-background [&>svg]:text-success",
        destructive:
          "border-destructive/35 bg-background [&>svg]:text-destructive",
      },
      size: {
        default: "px-4 py-3",
        compact: "gap-y-0.5 px-3 py-2 text-xs has-[>svg]:gap-x-2",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Alert({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-variant={variant ?? "default"}
      data-size={size ?? "default"}
      role={variant === "destructive" ? "alert" : "status"}
      className={cn(alertVariants({ variant, size }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 min-w-0 [overflow-wrap:anywhere] font-medium leading-snug text-foreground", className)}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid min-w-0 grid-cols-1 justify-items-start gap-1 [overflow-wrap:anywhere] text-[length:inherit] leading-relaxed text-foreground [&>*]:min-w-0 [&>*]:max-w-full [&_code]:whitespace-normal [&_p]:leading-relaxed",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertDescription, AlertTitle, alertVariants }
