/**
 * `#/settings` (supervisors only): one tab per area — routing & AI, business hours,
 * team & skills, queues, sounds, the website call button and API keys. The tab is part
 * of the route (`#/settings/queues`) so it survives reloads and can be linked. Each card
 * owns its queries and mutations against `/api/admin/*` and confirms saves with a toast.
 */
import { Box, Tab, Tabs } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { ApiKeysCard } from '../components/ApiKeysCard.tsx';
import { EmbedCard } from '../components/settings/EmbedCard.tsx';
import { HoursCard } from '../components/settings/HoursCard.tsx';
import { QueuesCard } from '../components/settings/QueuesCard.tsx';
import { RoutingCard } from '../components/settings/RoutingCard.tsx';
import { SoundsCard } from '../components/settings/SoundsCard.tsx';
import { TeamCard } from '../components/settings/TeamCard.tsx';

/** The settings tabs in display order: route segment, `settings` namespace label key and card. */
export const SETTINGS_TABS = [
  { key: 'routing', label: 'tabs.routing', card: RoutingCard },
  { key: 'hours', label: 'tabs.hours', card: HoursCard },
  { key: 'team', label: 'tabs.team', card: TeamCard },
  { key: 'queues', label: 'tabs.queues', card: QueuesCard },
  { key: 'sounds', label: 'tabs.sounds', card: SoundsCard },
  { key: 'embed', label: 'tabs.embed', card: EmbedCard },
  { key: 'api-keys', label: 'tabs.apiKeys', card: ApiKeysCard },
] as const;

/** See the module comment. `tab` is the route segment; unknown values show the first tab. */
export function Settings({ tab }: { tab?: string | undefined }) {
  const { t } = useTranslation('settings');
  const current = SETTINGS_TABS.find((x) => x.key === tab) ?? SETTINGS_TABS[0];
  const Card = current.card;
  return (
    <Box>
      <Tabs
        value={current.key}
        onChange={(_e, v: string) => (location.hash = `#/settings/${v}`)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
      >
        {SETTINGS_TABS.map((tab) => (
          <Tab key={tab.key} value={tab.key} label={t(tab.label)} />
        ))}
      </Tabs>
      <Card />
    </Box>
  );
}
