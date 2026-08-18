import { useAuth } from '@/contexts/AuthContext';
import { isStaffRole } from '@/lib/permissions';
import { staffRoleLabels } from '../../../../lib/vertical/terms';

/**
 * Selection-1: the choice /api/crm/auth-context has been asking for.
 *
 * The server refuses to pick a workspace for a user who belongs to several —
 * it answers `requiresWorkspaceSelection` and leaves workspaceId null — but
 * nothing in the app ever offered the choice. Such a user was told their
 * account was not linked to a clinic and had nowhere to go, and a second
 * device or cleared site data put them there permanently.
 *
 * The list comes from the session's verified memberships. Picking here selects
 * among what the server already granted; it grants nothing, and every request
 * is still authorized on its own.
 */
export function WorkspacePicker() {
  const { availableWorkspaces, clinicId, isLoading, isDemoMode, isImpersonation, selectWorkspace, signOut } = useAuth();

  const needsChoice =
    !isLoading && !clinicId && !isDemoMode && !isImpersonation && availableWorkspaces.length > 1;
  if (!needsChoice) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Выбор клиники"
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ background: 'rgba(10, 12, 16, 0.72)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-6 shadow-xl"
        style={{ background: 'var(--negis-surface)', color: 'var(--negis-text)' }}
      >
        <h2 className="text-lg font-semibold">Выберите клинику</h2>
        <p className="mt-1 text-sm opacity-70">
          Ваш аккаунт связан с несколькими клиниками. Выберите, в какой работать сейчас.
        </p>

        <ul className="mt-5 space-y-2">
          {availableWorkspaces.map((workspace) => (
            <li key={workspace.id}>
              <button
                type="button"
                onClick={() => selectWorkspace(workspace.id)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors hover:opacity-90"
                style={{ borderColor: 'var(--negis-border)' }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {workspace.name || 'Клиника без названия'}
                  </span>
                  <span className="block truncate text-xs opacity-60">
                    {isStaffRole(workspace.role) ? staffRoleLabels(workspace.vertical)[workspace.role] : workspace.role}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={signOut}
          className="mt-5 text-sm underline opacity-70 transition-opacity hover:opacity-100"
        >
          Выйти из аккаунта
        </button>
      </div>
    </div>
  );
}

export default WorkspacePicker;
