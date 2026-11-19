import { useEffect, useId, useState } from 'react';
import { ChevronRight, FlaskConical } from 'lucide-react';
import { isLegacyTestProject } from '@/modules/sidebar/utils/sidebarOrganization';

import type { SidebarProjectListProps } from '@/shared/types';
import { getPageTitle } from '@/shared/utils';
import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';
import SidebarProjectsState from '@/modules/sidebar/SidebarProjectsState';


/** Rendered by SidebarContent to list the filtered projects, delegating each row to SidebarProjectItem. */
export default function SidebarProjectList({
  groupLegacyTests = false,
  expandLegacyTests = false,
  projects,
  filteredProjects,
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
}: SidebarProjectListProps & { groupLegacyTests?: boolean; expandLegacyTests?: boolean }) {
  const [legacyOpen, setLegacyOpen] = useState(false);
  const legacyGroupId = useId();
  const legacyExpanded = legacyOpen || expandLegacyTests;
  const legacyProjects = groupLegacyTests ? filteredProjects.filter(isLegacyTestProject) : [];
  const mainProjects = groupLegacyTests ? filteredProjects.filter(project => !isLegacyTestProject(project)) : filteredProjects;
  useEffect(() => {
    if (selectedProject && isLegacyTestProject(selectedProject)) setLegacyOpen(true);
  }, [selectedProject?.projectId]);
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

  const renderProject = (project: SidebarProjectListProps['projects'][number]) => {
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
        {mainProjects.map(renderProject)}
        {legacyProjects.length > 0 && <section className="mt-3 border-t border-border/60 pt-2" data-testid="legacy-test-projects">
          <button type="button" aria-expanded={legacyExpanded} aria-controls={legacyGroupId}
            onClick={() => setLegacyOpen(value => !value)}
            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent/50">
            <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${legacyExpanded ? 'rotate-90' : ''}`} />
            <FlaskConical className="h-4 w-4 shrink-0" />
            <span className="flex-1">Workspace test cũ</span>
            <span className="tabular-nums">{legacyProjects.length}</span>
          </button>
          <div id={legacyGroupId} hidden={!legacyExpanded}>
            {legacyExpanded && legacyProjects.map(renderProject)}
          </div>
        </section>}
      </>}
    </div>
  );
}
