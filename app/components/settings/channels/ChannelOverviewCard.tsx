import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type ChannelOverviewCardProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  statusLabel: string;
  statusTone?: 'active' | 'warning' | 'error' | 'neutral';
  details: string[];
};

const statusToneClass: Record<NonNullable<ChannelOverviewCardProps['statusTone']>, string> = {
  active: 'border-primary/30 bg-primary/5 text-primary',
  warning: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  neutral: 'border-border bg-muted/40 text-muted-foreground',
};

export function ChannelOverviewCard({
  icon: Icon,
  title,
  description,
  statusLabel,
  statusTone = 'neutral',
  details,
}: ChannelOverviewCardProps) {
  return (
    <Card>
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-5 w-5" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4 sm:px-6 sm:pb-6">
        <div className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium ${statusToneClass[statusTone]}`}>
          {statusLabel}
        </div>
        <ul className="space-y-1 text-sm text-muted-foreground">
          {details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
