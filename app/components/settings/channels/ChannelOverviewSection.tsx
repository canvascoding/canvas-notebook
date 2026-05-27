import { Link2, MessageSquare } from 'lucide-react';
import { ChannelOverviewCard } from './ChannelOverviewCard';

type ChannelOverviewSectionProps = {
  telegramLinked: boolean;
};

export function ChannelOverviewSection({ telegramLinked }: ChannelOverviewSectionProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChannelOverviewCard
        icon={MessageSquare}
        title="Web Chat"
        description="Der Chat in Canvas ist der feste Web-Channel und bleibt immer aktiv."
        statusLabel="Aktiv"
        statusTone="active"
        details={[
          'Alle Agent-Sessions sind im Web sichtbar.',
          'Antworten erscheinen hier live, auch wenn die letzte Nachricht aus Telegram kam.',
          'Web nutzt dieselbe gemeinsame Historie wie verbundene externe Channels.',
        ]}
      />
      <ChannelOverviewCard
        icon={Link2}
        title="Gemeinsame Channel-Historie"
        description="Channels sind verschiedene Wege, mit derselben Agent-Session zu sprechen."
        statusLabel="Web + Telegram vorbereitet"
        statusTone={telegramLinked ? 'active' : 'neutral'}
        details={[
          'Telegram kann dieselbe Session-Historie wie der Web-Chat nutzen.',
          'Externe Antworten gehen standardmäßig an den zuletzt aktiven externen Channel.',
          'Weitere Channels wie Slack können später als Adapter ergänzt werden.',
        ]}
      />
    </div>
  );
}
