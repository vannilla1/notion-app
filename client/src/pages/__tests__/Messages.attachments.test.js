import { describe, it, expect, vi } from 'vitest';

// Messages.jsx ťahá celý strom stránky (api, kontexty, hlavičkové komponenty).
// Testujeme len čistú funkciu msgAttachmentsWouldOverflow, takže ťažké
// moduly nahradíme prázdnymi stubmi — vi.mock sa hoistuje pred import.
vi.mock('@/api/api', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('../../context/WorkspaceContext', () => ({ useWorkspace: () => ({}) }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => ({ socket: null, isConnected: false }) }));
vi.mock('../../hooks', () => ({
  useWorkspaceSwitched: () => {},
  useAppResume: () => {},
  useWorkspaceUsers: () => ({ users: [] }),
  isDeepLinkPending: () => false,
}));
vi.mock('../../components/UserMenu', () => ({ default: () => null }));
vi.mock('../../components/HelpGuide', () => ({ default: () => null }));
vi.mock('../../components/WorkspaceSwitcher', () => ({ default: () => null }));
vi.mock('../../components/HeaderLogo', () => ({ default: () => null }));
vi.mock('../../components/NotificationBell', () => ({ default: () => null }));
vi.mock('../../components/AnnouncementBanner', () => ({ default: () => null }));
vi.mock('../../components/FilePreviewModal', () => ({ default: () => null }));

import { msgAttachmentsWouldOverflow } from '../Messages';

const MB = 1024 * 1024;
const file = (size) => ({ size, name: 'x.bin' });

describe('msgAttachmentsWouldOverflow (16 MB strop dokumentu správy)', () => {
  it('bez správy alebo súboru nič nehlási', () => {
    expect(msgAttachmentsWouldOverflow(null, file(MB))).toBe(false);
    expect(msgAttachmentsWouldOverflow({ files: [] }, null)).toBe(false);
  });

  it('zmigrovaná správa (prílohy v R2, bez inline) nikdy nepretečie — ani pri veľkom súbore', () => {
    const msg = {
      attachment: { size: 9 * MB },
      files: [{ size: 9 * MB }, { size: 9 * MB, inline: false }],
      comments: [{ attachment: { size: 9 * MB } }],
    };
    expect(msgAttachmentsWouldOverflow(msg, file(50 * MB))).toBe(false);
  });

  it('do súčtu ráta IBA prílohy s inline: true (server flag)', () => {
    // 3× 5 MB inline → base64 ~20 MB, nový 1 MB súbor už strop presiahne
    const inlineMsg = {
      files: [{ size: 5 * MB, inline: true }, { size: 5 * MB, inline: true }, { size: 5 * MB, inline: true }],
    };
    expect(msgAttachmentsWouldOverflow(inlineMsg, file(MB))).toBe(true);

    // tie isté veľkosti bez príznaku inline (už v R2) → prejde
    const migratedMsg = {
      files: [{ size: 5 * MB }, { size: 5 * MB, inline: false }, { size: 5 * MB }],
    };
    expect(msgAttachmentsWouldOverflow(migratedMsg, file(MB))).toBe(false);
  });

  it('inline legacy príloha aj príloha komentára sa rátajú, malý prírastok pod stropom prejde', () => {
    const msg = {
      attachment: { size: 4 * MB, inline: true },
      comments: [{ attachment: { size: 4 * MB, inline: true } }],
    };
    // ~10.7 MB base64 + 1 MB → pod 15.5 MB budgetom
    expect(msgAttachmentsWouldOverflow(msg, file(MB))).toBe(false);
    // ~10.7 MB base64 + 4 MB (→ ~5.3 MB base64) → cez budget
    expect(msgAttachmentsWouldOverflow(msg, file(4 * MB))).toBe(true);
  });

  it('skipLegacyAttachment vynechá inline legacy prílohu (nahrádza sa novou)', () => {
    const msg = { attachment: { size: 11 * MB, inline: true }, files: [{ size: MB, inline: true }] };
    expect(msgAttachmentsWouldOverflow(msg, file(2 * MB))).toBe(true);
    expect(msgAttachmentsWouldOverflow(msg, file(2 * MB), { skipLegacyAttachment: true })).toBe(false);
  });
});
