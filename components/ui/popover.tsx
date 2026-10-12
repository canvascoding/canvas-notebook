"use client"

import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { Popover as ScopedPopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

const popoverContentClassName = "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 rounded-md border p-4 shadow-md outline-none"
type PopoverPortalContainer = React.ComponentProps<typeof PopoverPrimitive.Portal>["container"]

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      {...props}
    />
  )
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  portalContainer,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & { portalContainer?: PopoverPortalContainer }) {
  return (
    <PopoverPrimitive.Portal container={portalContainer}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          popoverContentClassName,
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function ScopedPopover(props: React.ComponentProps<typeof ScopedPopoverPrimitive.Root>) {
  return <ScopedPopoverPrimitive.Root data-slot="popover" {...props} />
}

function ScopedPopoverTrigger(props: React.ComponentProps<typeof ScopedPopoverPrimitive.Trigger>) {
  return <ScopedPopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function ScopedPopoverContent({ className, align = "center", sideOffset = 4, portalContainer, ...props }:
  React.ComponentProps<typeof ScopedPopoverPrimitive.Content> & { portalContainer?: PopoverPortalContainer }) {
  return <ScopedPopoverPrimitive.Portal container={portalContainer}>
    <ScopedPopoverPrimitive.Content data-slot="popover-content" align={align} sideOffset={sideOffset}
      className={cn(popoverContentClassName, className)} {...props} />
  </ScopedPopoverPrimitive.Portal>
}

export { Popover, PopoverTrigger, PopoverContent, ScopedPopover, ScopedPopoverTrigger, ScopedPopoverContent }
