import { useEffect, useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import type { SidebarProjectListProps } from '@/shared/types';
import { getPageTitle } from '@/shared/utils';
import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';
import SidebarProjectsState from '@/modules/sidebar/SidebarProjectsState';


/** Rendered by SidebarContent to list the filtered projects, delegating each row to SidebarProjectItem. */
export default function SidebarProjectList({
  projects,
  filteredProjects,
  showAllProjects = false,
  selectedProject,
  selectedSession,
  isLoading,
  loadingProgress,
  isProjectExpanded,
  activeRename,
  initialSessionsLoaded,
  currentTime,

  deletingProjects,
  tasksEnabled,
  mcpServerStatus,
  getProjectSessions,
  onLoadMoreSessions,
  loadingMoreProjects,
  activeSessions,
  backgroundSessionIds,
  attentionSessionIds,
  isProjectStarred,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  sessionSelection,
  onSetSessionSelection,
  onToggleSessionSelected,
  onCancelSessionSelection,
  onDeleteSelectedSessions,
  t,
}: SidebarProjectListProps) {
  const pageTitle = getPageTitle(selectedProject, selectedSession);
  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;

  const [otherOpen, setOtherOpen] = useState(false);
  const otherId = useId();
  const pinned = filteredProjects.filter((project) => isProjectStarred(project.projectId));
  const ordinary = filteredProjects.filter((project) => !isProjectStarred(project.projectId));
  const isInUse = (project: typeof projects[number]) =>
    selectedProject?.projectId === project.projectId
    || isProjectExpanded(project.projectId)
    || (activeRename?.target === 'project' ? activeRename.id : activeRename?.projectId) === project.projectId
    || sessionSelection?.projectId === project.projectId
    || getProjectSessions(project).some((session) => activeSessions.has(session.id)
      || backgroundSessionIds.has(session.id) || attentionSessionIds.has(session.id));
  const visible = ordinary.filter((project, index) => showAllProjects || index < 8 || isInUse(project));
  const visibleIds = new Set(visible.map((project) => project.projectId));
  const others = ordinary.filter((project) => !visibleIds.has(project.projectId));
  const renderProject = (project: typeof projects[number]) => {
    // Both renames are resolved here rather than inside the row, so
    // every other row is handed the same scalars on each keystroke and
    // its memo boundary holds.
    const renamingProject =
      activeRename?.target === 'project' && activeRename.id === project.projectId
        ? activeRename
        : null;
    const renamingSession =
      activeRename?.target === 'session' && activeRename.projectId === project.projectId
        ? activeRename
        : null;
    // Resolved here for the same reason as the renames: only the
    // project in selection mode sees a set, every other row keeps
    // being handed the same `null` and its memo holds.
    const selectedSessionIds =
      sessionSelection?.projectId === project.projectId ? sessionSelection.sessionIds : null;

    // React key + per-project state lookups all use the DB `projectId`
    // so they remain stable across renames and session changes.
    return (
    <SidebarProjectItem
      key={project.projectId}
      project={project}
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      isExpanded={isProjectExpanded(project.projectId)}
      isDeleting={deletingProjects.has(project.projectId)}
      isStarred={isProjectStarred(project.projectId)}
      isEditing={renamingProject !== null}
      renameDraft={renamingProject?.draft ?? ''}
      sessions={getProjectSessions(project)}
      initialSessionsLoaded={initialSessionsLoaded.has(project.projectId)}
      isLoadingMoreSessions={loadingMoreProjects.has(project.projectId)}
      currentTime={currentTime}
      sessionRenameId={renamingSession?.id ?? null}
      sessionRenameDraft={renamingSession?.draft ?? ''}
      tasksEnabled={tasksEnabled}
      mcpServerStatus={mcpServerStatus}
      onRenameDraftChange={onRenameDraftChange}
      onToggleProject={onToggleProject}
      onProjectSelect={onProjectSelect}
      onToggleStarProject={onToggleStarProject}
      onStartEditingProject={onStartEditingProject}
      onCancelEditingProject={onCancelEditingProject}
      onSaveProjectName={onSaveProjectName}
      onDeleteProject={onDeleteProject}
      onSessionSelect={onSessionSelect}
      onDeleteSession={onDeleteSession}
      onForkSession={onForkSession}
      onLoadMoreSessions={onLoadMoreSessions}
      activeSessions={activeSessions}
      backgroundSessionIds={backgroundSessionIds}
      attentionSessionIds={attentionSessionIds}
      onNewSession={onNewSession}
      onStartEditingSession={onStartEditingSession}
      onCancelEditingSession={onCancelEditingSession}
      onSaveEditingSession={onSaveEditingSession}
      selectedSessionIds={selectedSessionIds}
      onSetSessionSelection={onSetSessionSelection}
      onToggleSessionSelected={onToggleSessionSelected}
      onCancelSessionSelection={onCancelSessionSelection}
      onDeleteSelectedSessions={onDeleteSelectedSessions}
      t={t}
    />
  );
  };

  return (
    <div className="pb-safe-area-inset-bottom md:space-y-1">
      {!showProjects ? state : <>
        {pinned.length > 0 && <section aria-label={t('projectOrganization.pinned')}>
          <h3 className="px-4 py-2 text-xs font-medium text-muted-foreground">{t('projectOrganization.pinned')}</h3>
          {pinned.map(renderProject)}
        </section>}
        {visible.map(renderProject)}
        {others.length > 0 && <section className="mt-2 border-t border-border/60 pt-2">
          <button type="button" aria-expanded={otherOpen} aria-controls={otherId}
            className="flex w-full items-center gap-2 rounded px-4 py-2 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setOtherOpen((open) => !open)}>
            <ChevronRight aria-hidden="true" className={`h-4 w-4 shrink-0 transition-transform ${otherOpen ? 'rotate-90' : ''}`} />
            <span>{t('projectOrganization.other', { count: others.length })}</span>
          </button>
          <div id={otherId} hidden={!otherOpen}>{otherOpen && others.map(renderProject)}</div>
        </section>}
      </>}
    </div>
  );
}
