import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ModelLibraryPanel from '@/modules/chat/modals/ModelLibraryPanel';
import { useProviderModelCatalog } from '@/modules/settings/hooks/useProviderModelCatalog';
import SettingsSection from '@/modules/settings/SettingsSection';

/**
 * Rendered by Settings for the "models" tab: add, edit and remove custom models per provider without opening a chat.
 * It reuses the chat's ModelLibraryPanel, which has its own provider switcher, so this tab adds no controls of its own.
 */
export default function ModelsSettingsTab() {
  const { t } = useTranslation('settings');
  const { providerModelCatalog, isLoading, actions } = useProviderModelCatalog();

  return (
    <SettingsSection title={t('models.title')} description={t('models.description')}>
      {isLoading && Object.keys(providerModelCatalog).length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('models.loading')}
        </div>
      ) : (
        <ModelLibraryPanel initialProvider="claude" providerModelCatalog={providerModelCatalog} actions={actions} />
      )}
    </SettingsSection>
  );
}
