import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import api from '@/api/api';
import { downloadBlob } from '../utils/fileDownload';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import { useNavigate, useLocation } from 'react-router-dom';
import UserMenu from '../components/UserMenu';
import HelpGuide from '../components/HelpGuide';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';
import HeaderLogo from '../components/HeaderLogo';
import NotificationBell from '../components/NotificationBell';
import { useWorkspace } from '../context/WorkspaceContext';
import FilePreviewModal from '../components/FilePreviewModal';
import { linkifyText } from '../utils/linkify';

const messagesHelpTips = [
  {
    icon: '📨',
    title: 'Na čo slúžia správy',
    description: 'Správy sú interná komunikácia vo vašom tíme. Môžete cez ne posielať žiadosti o schválenie, návrhy, informácie alebo ankety. Správy sa zobrazujú v troch záložkách: "Všetky" (prijaté aj odoslané spolu), "Prijaté" (správy adresované vám) a "Odoslané" (správy, ktoré ste poslali vy).'
  },
  {
    icon: '✉️',
    title: 'Ako vytvoriť novú správu',
    description: 'Kliknite na fialové tlačidlo "+ Nová správa" vpravo hore. Vo formulári vyberte príjemcu (člen vášho tímu), typ správy a napíšte predmet a popis. Voliteľne môžete priložiť súbor, prepojiť správu s kontaktom alebo projektom a nastaviť termín na odpoveď. Odošlite tlačidlom "Odoslať".'
  },
  {
    icon: '🟡',
    title: 'Aké sú typy správ',
    description: 'Schválenie (žltá) — keď potrebujete od niekoho súhlas alebo rozhodnutie. Informácia (modrá) — keď chcete niekoho len informovať, nevyžaduje sa odpoveď. Žiadosť (oranžová) — keď prosíte o vykonanie nejakej akcie. Návrh (zelená) — keď chcete otvoriť diskusiu. Anketa (ružová) — keď chcete, aby tím hlasoval.'
  },
  {
    icon: '📊',
    title: 'Ako vytvoriť anketu',
    description: 'Pri vytváraní správy vyberte typ "Anketa". Zobrazí sa sekcia, kde pridáte 2 až 10 možností na výber. Zvoľte, či sa dá vybrať len jedna odpoveď alebo viacero. Po odoslaní členovia tímu hlasujú kliknutím na možnosť. Výsledky sa zobrazujú priebežne s percentami a menami hlasujúcich.'
  },
  {
    icon: '✅',
    title: 'Ako schváliť alebo zamietnuť správu',
    description: 'Keď otvoríte prijatú správu typu "Schválenie", "Žiadosť" alebo "Návrh", dole uvidíte tlačidlá: zelené "Schváliť" a červené "Zamietnuť". Kliknite na jedno z nich. Odosielateľ okamžite dostane upozornenie o vašom rozhodnutí. Ak si rozhodnutie rozmyslíte, môžete ho zrušiť a vrátiť správu späť na posúdenie.'
  },
  {
    icon: '💬',
    title: 'Ako pridať komentár ku správe',
    description: 'V detaile správy nájdete dole pole "Napíšte komentár". Napíšte text a kliknite na tlačidlo odoslania. Ku komentáru môžete voliteľne priložiť aj súbor. Vaše vlastné komentáre môžete upraviť (ikona ceruzky) alebo vymazať (ikona koša). Komentáre ostatných sa nedajú meniť ani mazať.'
  },
  {
    icon: '📎',
    title: 'Ako priložiť súbory ku správe',
    description: 'Pri vytváraní správy alebo komentára kliknite na ikonu kancelárskej sponky (📎). Vyberte súbor z vášho zariadenia — obrázky, dokumenty (PDF, Word, Excel), textové súbory a ďalšie formáty. Maximálna veľkosť jedného súboru je 10 MB. Ku jednej správe môžete priložiť aj viacero súborov.'
  },
  {
    icon: '🔗',
    title: 'Ako prepojiť správu s kontaktom alebo projektom',
    description: 'Pri vytváraní správy nájdete pole "Prepojenie". Kliknite naň a vyberte kontakt alebo projekt, ku ktorému správa patrí. Prepojená správa sa potom zobrazí aj v detaile daného kontaktu alebo projektu — takže váš tím má všetky informácie na jednom mieste.'
  },
  {
    icon: '🔍',
    title: 'Ako filtrovať správy',
    description: 'Nad zoznamom správ nájdete filtre podľa stavu: "Všetky", "Čaká" (ešte nerozhodnuté), "Schválené", "Zamietnuté" a "Komentované". Filter "Ankety" zobrazí len ankety. V bočnom paneli (na počítači vľavo) vidíte štatistiky počtu správ v jednotlivých stavoch — kliknutím na číslo sa zobrazí príslušný filter.'
  },
  {
    icon: '🗑️',
    title: 'Ako upraviť alebo vymazať správu',
    description: 'Vlastné odoslané správy môžete upraviť alebo vymazať — v detaile správy kliknite na ikonu ceruzky (upraviť) alebo koša (vymazať). Vlastník a manažér prostredia môžu vymazať akúkoľvek správu v rámci svojho prostredia, aj keď ju nepísali oni.'
  },
  {
    icon: '🔔',
    title: 'Zvonček notifikácií',
    description: 'Fialový zvonček vpravo hore zobrazuje centrum notifikácií. Červené číslo znamená neprečítané upozornenia. Kliknutím sa otvorí panel — neprečítané majú fialový okraj a bodku, prečítané sú vyblednuté. Kliknutím na notifikáciu o správe sa priamo otvorí a zvýrazní daná správa — či už ide o novú správu, komentár, schválenie alebo zamietnutie.'
  }
];

const typeConfig = {
  approval: { label: 'Schválenie', icon: '🟡', color: '#F59E0B' },
  info: { label: 'Informácia', icon: '🔵', color: '#3B82F6' },
  request: { label: 'Žiadosť', icon: '🟠', color: '#F97316' },
  proposal: { label: 'Návrh', icon: '🟢', color: '#10B981' },
  poll: { label: 'Anketa', icon: '📊', color: '#EC4899' }
};

const statusConfig = {
  pending: { label: 'Čaká', icon: '🕐', color: '#F59E0B' },
  approved: { label: 'Schválené', icon: '✅', color: '#10B981' },
  rejected: { label: 'Zamietnuté', icon: '❌', color: '#EF4444' },
  commented: { label: 'Komentované', icon: '💬', color: '#6366F1' }
};

function Messages() {
  const { user, logout, updateUser } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const { socket, isConnected } = useSocket();

  const [allMessages, setAllMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('all'); // all | received | sent
  const [statusFilter, setStatusFilter] = useState('all');
  const [pendingCount, setPendingCount] = useState(0);

  // New message form
  const [showForm, setShowForm] = useState(false);
  const [users, setUsers] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [form, setForm] = useState({
    toUserId: '', type: 'approval', subject: '', description: '',
    linkedType: '', linkedId: '', linkedName: '', dueDate: '',
    pollOptions: ['', ''], pollMultipleChoice: false
  });
  const [attachment, setAttachment] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Detail view
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [commentAttachment, setCommentAttachment] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState(null);
  const [editingCommentText, setEditingCommentText] = useState('');
  const [highlightedCommentId, setHighlightedCommentId] = useState(null);

  // File attachments
  const [uploadingFile, setUploadingFile] = useState(false);
  const [previewFile, setPreviewFile] = useState(null); // { file, downloadUrl } for preview modal
  const msgFileInputRef = useRef(null);
  const [activeFileMessageId, setActiveFileMessageId] = useState(null);

  // Sidebar
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [highlightedMessageIds, setHighlightedMessageIds] = useState(new Set());

  // Filtered messages for display
  const messages = useMemo(() => {
    if (statusFilter === 'all') return allMessages;
    if (statusFilter === 'poll') return allMessages.filter(m => m.type === 'poll');
    return allMessages.filter(m => m.status === statusFilter);
  }, [allMessages, statusFilter]);

  // Stats for sidebar (always from all messages)
  const receivedMessages = allMessages;
  const messageStats = useMemo(() => ({
    pending: allMessages.filter(m => m.status === 'pending'),
    approved: allMessages.filter(m => m.status === 'approved'),
    rejected: allMessages.filter(m => m.status === 'rejected'),
    commented: allMessages.filter(m => m.status === 'commented'),
    poll: allMessages.filter(m => m.type === 'poll'),
  }), [allMessages]);
  const { pending: pendingMessages, approved: approvedMessages, rejected: rejectedMessages, commented: commentedMessages, poll: pollMessages } = messageStats;

  useEffect(() => { setLoading(true); fetchMessages(); fetchPendingCount(); }, [tab]);

  // Refresh when app returns from background (iOS / tab switch)
  useEffect(() => {
    const handleResume = () => { fetchMessages(); fetchPendingCount(); };
    window.addEventListener('app-resumed', handleResume);
    return () => window.removeEventListener('app-resumed', handleResume);
  }, [tab]);

  // Refetch when workspace switches (deep-link from push notification can
  // change the active workspace; this page's state otherwise keeps messages
  // from the previous workspace).
  useEffect(() => {
    const handleSwitch = () => { fetchMessages(); fetchPendingCount(); };
    window.addEventListener('workspace-switched', handleSwitch);
    return () => window.removeEventListener('workspace-switched', handleSwitch);
  }, [tab]);

  // Mark notifications for this message as read whenever the user opens one
  // (list click, deep-link, fetched detail). Replaces the old "mark the
  // whole Messages section as read on nav tap" behavior. Server endpoint is
  // idempotent so repeated firings (e.g. when detail re-fetches and sets
  // selectedMessage again) are harmless.
  useEffect(() => {
    if (!selectedMessage) return;
    const messageId = selectedMessage.id || selectedMessage._id;
    if (!messageId) return;
    api.put('/api/notifications/read-for-related', {
      relatedType: 'message',
      relatedId: messageId
    }).then(() => {
      window.dispatchEvent(new CustomEvent('notifications-updated'));
    }).catch(() => {});
  }, [selectedMessage]);

  useEffect(() => {
    if (showForm) { fetchUsers(); fetchContactsAndTasks(); }
  }, [showForm]);

  // Socket events — debounced to coalesce rapid updates
  const msgFetchTimerRef = useRef(null);
  useEffect(() => {
    if (!socket || !isConnected) return;
    const refresh = () => {
      if (msgFetchTimerRef.current) clearTimeout(msgFetchTimerRef.current);
      msgFetchTimerRef.current = setTimeout(() => { fetchMessages(); fetchPendingCount(); }, 300);
    };
    socket.on('message-created', refresh);
    socket.on('message-updated', refresh);
    socket.on('message-deleted', refresh);
    return () => {
      socket.off('message-created', refresh);
      socket.off('message-updated', refresh);
      socket.off('message-deleted', refresh);
      if (msgFetchTimerRef.current) clearTimeout(msgFetchTimerRef.current);
    };
  }, [socket, isConnected, tab]);

  // Deep link tab (only on URL change, not on messages change)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tabParam = params.get('tab');
    if (tabParam === 'all' || tabParam === 'received' || tabParam === 'sent') {
      setTab(tabParam);
    }
  }, [location.search]);

  // Deep link highlight — fetch message by ID, switch to correct tab, select it
  const lastMsgHighlightRef = useRef(null);
  const highlightMessage = async (messageId, commentId = null) => {
    try {
      const res = await api.get(`/api/messages/${messageId}`);
      const msg = res.data;
      if (!msg) return;

      // Determine correct tab: if user is recipient → received, if sender → sent
      const userId = user?.id || user?._id;
      const isRecipient = msg.toUserId?.toString() === userId?.toString() ||
        msg.toUserId?._id?.toString() === userId?.toString();
      const correctTab = isRecipient ? 'received' : 'sent';

      if (tab !== correctTab) {
        setTab(correctTab);
      }
      // Clear any status filter to ensure message is visible
      if (statusFilter !== 'all') {
        setStatusFilter('all');
      }
      setSelectedMessage(msg);
      // Notification read-marking is handled centrally by the
      // `selectedMessage` effect below — deep-link, list-click, and any
      // other code path that opens a message all go through that hook.
      if (commentId) {
        setHighlightedCommentId(commentId);
        // Retry finding the comment element — on cold start the MessageDetail
        // may take a moment to mount + render comments[], so a single 300ms
        // timeout can miss it. Poll up to ~4s.
        let attempts = 0;
        const tryScroll = () => {
          attempts++;
          const el = document.getElementById(`comment-${commentId}`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }
          if (attempts < 40) setTimeout(tryScroll, 100);
        };
        setTimeout(tryScroll, 100);
        // Clear highlight after giving the user time to see it (measure from
        // when it's shown, not mount; extend to 6s for cold-start cases)
        setTimeout(() => setHighlightedCommentId(null), 6000);
      }
    } catch {
      // Silently fail — message may have been deleted
    }
  };

  // Handle highlight from URL params — unified for all sources (SW, iOS, direct link)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const highlightId = params.get('highlight');
    const commentId = params.get('comment');
    const urlTimestamp = params.get('_t');

    // Wait for App.jsx to resolve `ws=` first (cross-workspace deep link).
    if (params.get('ws')) {
      console.log('[DeepLink] Messages: ws= still present, deferring to App');
      return;
    }

    if (highlightId) {
      const tsKey = urlTimestamp || 'no-ts';
      if (tsKey !== lastMsgHighlightRef.current) {
        lastMsgHighlightRef.current = tsKey;
        console.log('[DeepLink] Messages: processing highlight=', highlightId, 'comment=', commentId);
        highlightMessage(highlightId, commentId);
        // Clear params from URL
        navigate(location.pathname, { replace: true });
      }
    }
  }, [location.search]);

  // Handle showUnread — highlight all messages that have unread notifications
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const showUnread = params.get('showUnread');
    const urlTimestamp = params.get('_t');

    if (showUnread && urlTimestamp !== lastMsgHighlightRef.current) {
      lastMsgHighlightRef.current = urlTimestamp || 'unread';
      navigate(location.pathname, { replace: true, state: {} });

      api.get('/api/notifications?unreadOnly=true&limit=50').then(res => {
        const msgNotifs = (res.data.notifications || []).filter(n =>
          n.type?.startsWith('message.')
        );
        const ids = new Set(msgNotifs.map(n => n.relatedId).filter(Boolean));
        if (ids.size > 0) {
          setHighlightedMessageIds(ids);
          const firstId = [...ids][0];
          setSelectedMessage(allMessages.find(m => (m._id || m.id) === firstId) || null);
          setTimeout(() => setHighlightedMessageIds(new Set()), 4000);
        }
      }).catch(() => {});
    }
  }, [location.search]);

  const fetchMessages = async () => {
    try {
      const res = await api.get('/api/messages', { params: { tab, status: 'all' } });
      setAllMessages(res.data);
      // Update selectedMessage if it's in the new list (keeps detail view fresh)
      setSelectedMessage(prev => {
        if (!prev) return null;
        const updated = res.data.find(m => (m.id || m._id) === (prev.id || prev._id));
        return updated || prev;
      });
    } catch (err) {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const fetchPendingCount = async () => {
    try {
      const res = await api.get('/api/messages/pending-count');
      setPendingCount(res.data.count);
    } catch (err) { /* ignore */ }
  };

  const fetchUsers = async () => {
    try {
      const res = await api.get('/api/auth/users');
      setUsers(res.data.filter(u => u.id !== user.id));
    } catch (err) { /* ignore */ }
  };

  const fetchContactsAndTasks = async () => {
    try {
      const [cRes, tRes] = await Promise.all([
        api.get('/api/contacts'),
        api.get('/api/tasks')
      ]);
      setContacts(cRes.data);
      setTasks(tRes.data);
    } catch (err) { /* ignore */ }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.toUserId || !form.subject.trim()) return;
    setSubmitting(true);

    try {
      const formData = new FormData();
      formData.append('toUserId', form.toUserId);
      formData.append('type', form.type);
      formData.append('subject', form.subject.trim());
      formData.append('description', form.description.trim());
      if (form.linkedType && form.linkedId) {
        formData.append('linkedType', form.linkedType);
        formData.append('linkedId', form.linkedId);
        formData.append('linkedName', form.linkedName);
      }
      if (form.dueDate) formData.append('dueDate', form.dueDate);
      if (form.type === 'poll') {
        formData.append('pollOptions', JSON.stringify(form.pollOptions.filter(o => o.trim())));
        formData.append('pollMultipleChoice', form.pollMultipleChoice);
      }
      if (attachment) formData.append('attachment', attachment);

      await api.post('/api/messages', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      setShowForm(false);
      resetForm();
      // setTab triggers useEffect which fetches messages — no manual fetch needed
      setTab('sent');
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba pri odosielaní');
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setForm({ toUserId: '', type: 'approval', subject: '', description: '', linkedType: '', linkedId: '', linkedName: '', dueDate: '', pollOptions: ['', ''], pollMultipleChoice: false });
    setAttachment(null);
  };

  const handleApprove = async (id) => {
    try {
      const res = await api.put(`/api/messages/${id}/approve`);
      setSelectedMessage(res.data);
      fetchMessages();
      fetchPendingCount();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba');
    }
  };

  const handleReject = async (id) => {
    try {
      const res = await api.put(`/api/messages/${id}/reject`, { reason: rejectReason });
      setSelectedMessage(res.data);
      setShowRejectDialog(false);
      setRejectReason('');
      fetchMessages();
      fetchPendingCount();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba');
    }
  };

  const handleComment = async (id) => {
    if (!commentText.trim()) return;
    try {
      const formData = new FormData();
      formData.append('text', commentText.trim());
      if (commentAttachment) formData.append('attachment', commentAttachment);
      const res = await api.post(`/api/messages/${id}/comment`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setSelectedMessage(res.data);
      setCommentText('');
      setCommentAttachment(null);
      fetchMessages();
      fetchPendingCount();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba');
    }
  };

  const handleEditComment = async (messageId, commentId, newText) => {
    if (!newText.trim()) return;
    try {
      const res = await api.put(`/api/messages/${messageId}/comment/${commentId}`, { text: newText.trim() });
      setSelectedMessage(res.data);
      setEditingCommentId(null);
      setEditingCommentText('');
      fetchMessages();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba');
    }
  };

  const handleDeleteComment = async (messageId, commentId) => {
    if (!window.confirm('Naozaj chcete vymazať tento komentár?')) return;
    try {
      const res = await api.delete(`/api/messages/${messageId}/comment/${commentId}`);
      setSelectedMessage(res.data);
      fetchMessages();
      fetchPendingCount();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba');
    }
  };

  const handleEdit = async (id, editData) => {
    try {
      const formData = new FormData();
      formData.append('subject', editData.subject);
      formData.append('description', editData.description);
      formData.append('type', editData.type);
      formData.append('dueDate', editData.dueDate || '');
      if (editData.linkedType) {
        formData.append('linkedType', editData.linkedType);
        formData.append('linkedId', editData.linkedId);
        formData.append('linkedName', editData.linkedName);
      }
      if (editData.newAttachment) {
        formData.append('attachment', editData.newAttachment);
      } else if (editData.removeAttachment) {
        formData.append('removeAttachment', 'true');
      }
      const res = await api.put(`/api/messages/${id}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setSelectedMessage(res.data);
      setEditing(false);
      fetchMessages();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba pri ukladaní');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Naozaj chcete vymazať tento odkaz?')) return;
    try {
      await api.delete(`/api/messages/${id}`);
      setSelectedMessage(null);
      fetchMessages();
      fetchPendingCount();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba');
    }
  };

  const handleLinkedChange = (linkedType, linkedId) => {
    let linkedName = '';
    if (linkedType === 'contact') {
      linkedName = contacts.find(c => c.id === linkedId)?.name || '';
    } else if (linkedType === 'task') {
      linkedName = tasks.find(t => t.id === linkedId)?.title || '';
    }
    setForm(f => ({ ...f, linkedType, linkedId, linkedName }));
  };

  const handleReopen = async (id) => {
    if (!window.confirm('Naozaj chcete zrušiť rozhodnutie a vrátiť správu na diskusiu?')) return;
    try {
      const res = await api.put(`/api/messages/${id}/reopen`);
      setSelectedMessage(res.data);
      fetchMessages();
      fetchPendingCount();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba');
    }
  };

  const handleVote = async (messageId, optionId) => {
    try {
      const res = await api.post(`/api/messages/${messageId}/vote`, { optionId });
      setSelectedMessage(res.data);
      fetchMessages();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba pri hlasovaní');
    }
  };

  // File helpers
  const isImage = (mimetype) => mimetype?.startsWith('image/');

  const getFileIcon = (mimetype) => {
    if (mimetype?.startsWith('image/')) return '🖼️';
    if (mimetype?.includes('pdf')) return '📄';
    if (mimetype?.includes('word') || mimetype?.includes('document')) return '📝';
    if (mimetype?.includes('sheet') || mimetype?.includes('excel')) return '📊';
    if (mimetype?.includes('presentation') || mimetype?.includes('powerpoint')) return '📽️';
    if (mimetype?.startsWith('video/')) return '🎬';
    if (mimetype?.startsWith('audio/')) return '🎵';
    return '📎';
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const triggerMsgFileUpload = (messageId) => {
    setActiveFileMessageId(messageId);
    setTimeout(() => msgFileInputRef.current?.click(), 0);
  };

  const onMsgFileSelected = (e) => {
    const file = e.target.files[0];
    if (!file || !activeFileMessageId) return;
    handleMsgFileUpload(activeFileMessageId, file);
    e.target.value = '';
  };

  const handleMsgFileUpload = async (messageId, file) => {
    setUploadingFile(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.post(`/api/messages/${messageId}/files`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 60000
      });
      setSelectedMessage(res.data);
      fetchMessages();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri nahrávaní súboru');
    } finally {
      setUploadingFile(false);
    }
  };

  const handleMsgFileDownload = async (messageId, fileId, fileName) => {
    try {
      const response = await api.get(`/api/messages/${messageId}/files/${fileId}/download`, { responseType: 'blob' });
      downloadBlob(response.data, fileName);
    } catch (error) {
      let msg = 'Chyba pri sťahovaní súboru';
      try {
        if (error.response?.data instanceof Blob) {
          const text = await error.response.data.text();
          const json = JSON.parse(text);
          if (json.message) msg = json.message;
        }
      } catch {}
      alert(msg);
    }
  };

  const handleMsgFileDelete = async (messageId, fileId) => {
    if (!window.confirm('Vymazať tento súbor?')) return;
    try {
      const res = await api.delete(`/api/messages/${messageId}/files/${fileId}`);
      setSelectedMessage(res.data);
      fetchMessages();
    } catch (error) {
      alert('Chyba pri mazaní súboru');
    }
  };

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('sk-SK') : '';
  const formatDateTime = (d) => d ? new Date(d).toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  const isRecipient = (msg) => {
    const toId = msg.toUserId?._id?.toString?.() || msg.toUserId?.toString?.() || msg.toUserId;
    return toId === user.id;
  };

  return (
    <div className="crm-container">
      <header className="crm-header">
        <div className="crm-header-left">
          <button className="btn-menu" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Menu">
            <span></span>
            <span></span>
            <span></span>
          </button>
          <HeaderLogo />
        </div>
        <div className="crm-header-right">
          <WorkspaceSwitcher />
          <button className="btn btn-secondary" onClick={() => navigate('/crm')}>Kontakty</button>
          <button className="btn btn-secondary" onClick={() => navigate('/tasks')}>Projekty</button>
          <NotificationBell />
          <UserMenu user={user} onLogout={logout} onUserUpdate={updateUser} />
        </div>
      </header>

      <div className="crm-content">
        <div
          className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`}
          onClick={() => setSidebarOpen(false)}
        />
        <aside className={`crm-sidebar ${sidebarOpen ? 'open' : ''}`}>
          <button
            className="btn btn-primary add-contact-btn"
            onClick={() => {
              setShowForm(true);
              setSidebarOpen(false);
            }}
          >
            + Nová správa
          </button>

          <div className="dashboard-stats">
            <h3>Prehľad</h3>
            <div
              className={`stat-item clickable ${statusFilter === 'all' ? 'active' : ''}`}
              onClick={() => { setStatusFilter('all'); setSidebarOpen(false); }}
            >
              <span className="stat-label">Celkom správ</span>
              <span className="stat-value">{receivedMessages.length}</span>
            </div>

            <h4 style={{ marginTop: '16px', marginBottom: '8px', color: 'var(--text-secondary)' }}>Podľa stavu</h4>
            <div
              className={`stat-item clickable priority-stat ${statusFilter === 'pending' ? 'active' : ''}`}
              onClick={() => { setStatusFilter('pending'); setSidebarOpen(false); }}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#F59E0B' }}></span>
                Čaká
              </span>
              <span className="stat-value">{pendingMessages.length}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${statusFilter === 'approved' ? 'active' : ''}`}
              onClick={() => { setStatusFilter('approved'); setSidebarOpen(false); }}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#10B981' }}></span>
                Schválené
              </span>
              <span className="stat-value">{approvedMessages.length}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${statusFilter === 'rejected' ? 'active' : ''}`}
              onClick={() => { setStatusFilter('rejected'); setSidebarOpen(false); }}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#EF4444' }}></span>
                Zamietnuté
              </span>
              <span className="stat-value">{rejectedMessages.length}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${statusFilter === 'commented' ? 'active' : ''}`}
              onClick={() => { setStatusFilter('commented'); setSidebarOpen(false); }}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#6366F1' }}></span>
                Komentované
              </span>
              <span className="stat-value">{commentedMessages.length}</span>
            </div>

            <h4 style={{ marginTop: '16px', marginBottom: '8px', color: 'var(--text-secondary)' }}>Podľa typu</h4>
            <div
              className={`stat-item clickable priority-stat ${statusFilter === 'poll' ? 'active' : ''}`}
              onClick={() => { setStatusFilter('poll'); setSidebarOpen(false); }}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#EC4899' }}></span>
                Ankety
              </span>
              <span className="stat-value">{pollMessages.length}</span>
            </div>
          </div>
        </aside>

        <main className="crm-main">
        <div className="messages-container" style={{ padding: '20px', maxWidth: '900px', margin: '0 auto', width: '100%' }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 600 }}>✉️ Správy</h2>
            {pendingCount > 0 && (
              <span style={{ background: 'var(--danger)', color: 'white', borderRadius: '10px', padding: '2px 8px', fontSize: '12px', fontWeight: 600 }}>{pendingCount}</span>
            )}
            <HelpGuide tips={messagesHelpTips} />
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: '0', marginBottom: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '3px', border: '1px solid var(--border-color)' }}>
            <button
              onClick={() => { setTab('all'); setSelectedMessage(null); }}
              style={{
                flex: 1, padding: '10px 16px', border: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: 600,
                borderRadius: 'calc(var(--radius-md) - 2px)',
                background: tab === 'all' ? 'var(--accent-color)' : 'transparent',
                color: tab === 'all' ? 'white' : 'var(--text-secondary)',
                transition: 'all 0.2s ease',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
              }}
            >
              Všetky {pendingCount > 0 && <span style={{ background: tab === 'all' ? 'rgba(255,255,255,0.25)' : 'var(--danger)', color: 'white', borderRadius: '10px', padding: '1px 7px', fontSize: '11px', fontWeight: 700 }}>{pendingCount}</span>}
            </button>
            <button
              onClick={() => { setTab('received'); setSelectedMessage(null); }}
              style={{
                flex: 1, padding: '10px 16px', border: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: 600,
                borderRadius: 'calc(var(--radius-md) - 2px)',
                background: tab === 'received' ? 'var(--accent-color)' : 'transparent',
                color: tab === 'received' ? 'white' : 'var(--text-secondary)',
                transition: 'all 0.2s ease',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
              }}
            >
              Prijaté {pendingCount > 0 && <span style={{ background: tab === 'received' ? 'rgba(255,255,255,0.25)' : 'var(--danger)', color: 'white', borderRadius: '10px', padding: '1px 7px', fontSize: '11px', fontWeight: 700 }}>{pendingCount}</span>}
            </button>
            <button
              onClick={() => { setTab('sent'); setSelectedMessage(null); }}
              style={{
                flex: 1, padding: '10px 16px', border: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: 600,
                borderRadius: 'calc(var(--radius-md) - 2px)',
                background: tab === 'sent' ? 'var(--accent-color)' : 'transparent',
                color: tab === 'sent' ? 'white' : 'var(--text-secondary)',
                transition: 'all 0.2s ease',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
              }}
            >
              Odoslané
            </button>
          </div>

          {/* Status filter */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: '16px', overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            {['all', 'pending', 'approved', 'rejected', 'commented', 'poll'].map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                style={{
                  padding: '4px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)',
                  background: statusFilter === s ? (s === 'poll' ? '#EC4899' : 'var(--accent-color)') : 'var(--bg-card)',
                  color: statusFilter === s ? 'white' : 'var(--text-secondary)',
                  cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap', flexShrink: 0
                }}
              >
                {s === 'all' ? 'Všetky' : s === 'poll' ? '📊 Ankety' : statusConfig[s]?.label || s}
              </button>
            ))}
          </div>

          {/* Message list OR detail */}
          {selectedMessage ? (
            <MessageDetail
              msg={selectedMessage}
              isRecipient={isRecipient(selectedMessage)}
              isSender={selectedMessage.fromUserId === user.id || selectedMessage.fromUserId?._id === user.id}
              canDelete={(selectedMessage.fromUserId === user.id || selectedMessage.fromUserId?._id === user.id) || currentWorkspace?.role === 'owner' || currentWorkspace?.role === 'manager'}
              onBack={() => { setSelectedMessage(null); fetchPendingCount(); }}
              onApprove={handleApprove}
              onReject={() => setShowRejectDialog(true)}
              onComment={handleComment}
              onDelete={handleDelete}
              onEdit={handleEdit}
              editing={editing}
              setEditing={setEditing}
              commentText={commentText}
              setCommentText={setCommentText}
              commentAttachment={commentAttachment}
              setCommentAttachment={setCommentAttachment}
              formatDate={formatDate}
              formatDateTime={formatDateTime}
              navigate={navigate}
              contacts={contacts}
              tasks={tasks}
              userId={user.id}
              onReopen={handleReopen}
              onVote={handleVote}
              canReopen={(selectedMessage.status === 'approved' || selectedMessage.status === 'rejected') && (currentWorkspace?.role === 'owner' || currentWorkspace?.role === 'manager' || isRecipient(selectedMessage))}
              canManageMessage={currentWorkspace?.role === 'owner' || currentWorkspace?.role === 'manager'}
              onFileUpload={triggerMsgFileUpload}
              onFileDownload={handleMsgFileDownload}
              onFileDelete={handleMsgFileDelete}
              onPreviewFile={setPreviewFile}
              uploadingFile={uploadingFile}
              getFileIcon={getFileIcon}
              formatFileSize={formatFileSize}
              isImage={isImage}
              onEditComment={handleEditComment}
              onDeleteComment={handleDeleteComment}
              editingCommentId={editingCommentId}
              setEditingCommentId={setEditingCommentId}
              editingCommentText={editingCommentText}
              setEditingCommentText={setEditingCommentText}
              highlightedCommentId={highlightedCommentId}
            />
          ) : (
            <MessageList
              messages={messages}
              loading={loading}
              tab={tab}
              onSelect={(msg) => {
                setSelectedMessage(msg);
                // Fetch full message detail (triggers readBy on backend), then refresh count
                api.get(`/api/messages/${msg.id || msg._id}`).then(res => {
                  setSelectedMessage(res.data);
                  fetchPendingCount();
                }).catch(() => {});
              }}
              formatDate={formatDate}
              formatDateTime={formatDateTime}
              userId={user.id}
              highlightedMessageIds={highlightedMessageIds}
            />
          )}
        </div>
        <input type="file" ref={msgFileInputRef} style={{ display: 'none' }} onChange={onMsgFileSelected} />
      </main>
      </div>

      {/* New message modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
          onClick={(e) => { if (e.target === e.currentTarget) { setShowForm(false); resetForm(); } }}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: '24px', width: '100%', maxWidth: '520px', maxHeight: '90vh', overflow: 'auto', boxShadow: 'var(--shadow-xl)' }}>
            <h3 style={{ marginBottom: '16px', fontSize: '18px' }}>Nová správa</h3>
            <form onSubmit={handleSubmit}>
              {/* Recipient */}
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Komu *</label>
                <select value={form.toUserId} onChange={e => setForm(f => ({ ...f, toUserId: e.target.value }))} required
                  style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px' }}>
                  <option value="">Vyberte príjemcu...</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.username} ({u.email})</option>)}
                </select>
              </div>

              {/* Type */}
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Typ *</label>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {Object.entries(typeConfig).map(([key, cfg]) => (
                    <button key={key} type="button"
                      onClick={() => setForm(f => ({ ...f, type: key }))}
                      style={{
                        padding: '6px 12px', borderRadius: 'var(--radius-sm)',
                        border: form.type === key ? `2px solid ${cfg.color}` : '1px solid var(--border-color)',
                        background: form.type === key ? `${cfg.color}15` : 'transparent',
                        cursor: 'pointer', fontSize: '13px'
                      }}>
                      {cfg.icon} {cfg.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Subject */}
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Predmet *</label>
                <input type="text" value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} required maxLength={200}
                  style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px' }}
                  placeholder="Stručný názov odkazu" />
              </div>

              {/* Description */}
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Popis</label>
                <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} maxLength={5000} rows={4}
                  style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px', resize: 'vertical' }}
                  placeholder="Podrobnejší popis..." />
              </div>

              {/* Poll options (only for poll type) */}
              {form.type === 'poll' && (
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Možnosti ankety *</label>
                  {form.pollOptions.map((opt, i) => (
                    <div key={i} style={{ display: 'flex', gap: '6px', marginBottom: '6px', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)', minWidth: '20px' }}>{i + 1}.</span>
                      <input type="text" value={opt} onChange={e => {
                        const newOpts = [...form.pollOptions];
                        newOpts[i] = e.target.value;
                        setForm(f => ({ ...f, pollOptions: newOpts }));
                      }} maxLength={200} placeholder={`Možnosť ${i + 1}`}
                        style={{ flex: 1, padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px' }} />
                      {form.pollOptions.length > 2 && (
                        <button type="button" onClick={() => {
                          const newOpts = form.pollOptions.filter((_, j) => j !== i);
                          setForm(f => ({ ...f, pollOptions: newOpts }));
                        }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: '16px', padding: '4px' }}>×</button>
                      )}
                    </div>
                  ))}
                  {form.pollOptions.length < 10 && (
                    <button type="button" onClick={() => setForm(f => ({ ...f, pollOptions: [...f.pollOptions, ''] }))}
                      style={{ background: 'none', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-sm)', padding: '6px 12px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-secondary)', width: '100%' }}>
                      + Pridať možnosť
                    </button>
                  )}
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.pollMultipleChoice} onChange={e => setForm(f => ({ ...f, pollMultipleChoice: e.target.checked }))} />
                    Povoliť výber viacerých možností
                  </label>
                </div>
              )}

              {/* Link to contact or task */}
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Prepojenie (voliteľné)</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <select value={form.linkedType} onChange={e => { setForm(f => ({ ...f, linkedType: e.target.value, linkedId: '', linkedName: '' })); }}
                    style={{ padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
                    <option value="">Žiadne</option>
                    <option value="contact">Kontakt</option>
                    <option value="task">Projekt</option>
                  </select>
                  {form.linkedType && (
                    <select value={form.linkedId} onChange={e => handleLinkedChange(form.linkedType, e.target.value)}
                      style={{ flex: 1, padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
                      <option value="">Vyberte...</option>
                      {form.linkedType === 'contact' && contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      {form.linkedType === 'task' && tasks.filter(t => !t.completed).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                    </select>
                  )}
                </div>
              </div>

              {/* Due date */}
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Termín (voliteľný)</label>
                <input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
                  style={{ padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px' }} />
              </div>

              {/* Attachment */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Príloha (voliteľná)</label>
                <input type="file" onChange={e => setAttachment(e.target.files[0] || null)}
                  style={{ fontSize: '13px' }} />
                {attachment && <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '8px' }}>{(attachment.size / 1024 / 1024).toFixed(1)} MB</span>}
              </div>

              {/* Buttons */}
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={() => { setShowForm(false); resetForm(); }}>Zrušiť</button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Odosielam...' : 'Odoslať'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reject dialog */}
      {/* File Preview Modal */}
      {previewFile && (
        <FilePreviewModal
          file={previewFile.file}
          downloadUrl={previewFile.downloadUrl}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {showRejectDialog && selectedMessage && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1001, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowRejectDialog(false); }}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: '24px', width: '100%', maxWidth: '400px', boxShadow: 'var(--shadow-xl)' }}>
            <h3 style={{ marginBottom: '12px', fontSize: '16px' }}>❌ Zamietnuť odkaz</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>Voliteľne uveďte dôvod zamietnutia:</p>
            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={3}
              style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px', resize: 'vertical', marginBottom: '12px' }}
              placeholder="Dôvod zamietnutia..." />
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowRejectDialog(false)}>Zrušiť</button>
              <button className="btn" style={{ background: 'var(--danger)', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                onClick={() => handleReject(selectedMessage.id || selectedMessage._id)}>
                Zamietnuť
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Message List ---
function MessageList({ messages, loading, tab, onSelect, formatDate, formatDateTime, userId, highlightedMessageIds }) {
  if (loading) return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Načítavam...</div>;
  if (messages.length === 0) return (
    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
      <div style={{ fontSize: '40px', marginBottom: '8px' }}>✉️</div>
      <p>{tab === 'received' ? 'Žiadne prijaté odkazy' : 'Žiadne odoslané odkazy'}</p>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {messages.map(msg => {
        const type = typeConfig[msg.type] || typeConfig.info;
        const status = statusConfig[msg.status] || statusConfig.pending;
        const isOverdue = msg.dueDate && msg.status === 'pending' && new Date(msg.dueDate) < new Date();

        return (
          <div key={msg.id || msg._id}
            onClick={() => onSelect(msg)}
            className={`message-item${highlightedMessageIds.has(msg.id || msg._id) ? ' highlighted' : ''}`}
            style={{
              padding: '12px 16px', borderRadius: 'var(--radius)', border: '1px solid var(--border-color)',
              background: 'var(--bg-card)',
              cursor: 'pointer', transition: 'var(--transition)',
              borderLeft: `3px solid ${type.color}`,
              opacity: msg.status === 'approved' || msg.status === 'rejected' ? 0.75 : 1
            }}
            onMouseEnter={e => e.currentTarget.style.boxShadow = 'var(--shadow)'}
            onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '14px' }}>{type.icon}</span>
              <span style={{ fontWeight: 600, fontSize: '14px', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {msg.subject}
              </span>
              <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', background: `${status.color}15`, color: status.color, fontWeight: 500, whiteSpace: 'nowrap' }}>
                {status.icon} {status.label}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
              <span>{tab === 'received' ? `Od: ${msg.fromUsername}` : `Pre: ${msg.toUsername}`}</span>
              <span>{formatDateTime(msg.createdAt)}</span>
              {msg.dueDate && (
                <span style={{ color: isOverdue ? 'var(--danger)' : 'var(--text-muted)' }}>
                  {isOverdue ? '⚠️' : '📅'} {formatDate(msg.dueDate)}
                </span>
              )}
              {(msg.attachment?.originalName || msg.files?.length > 0) && <span>📎 {(msg.files?.length || 0) + (msg.attachment?.originalName ? 1 : 0)}</span>}
              {msg.type === 'poll' && msg.pollOptions && <span>📊 {msg.pollOptions.reduce((s, o) => s + (o.votes?.length || 0), 0)} hlasov</span>}
              {msg.linkedName && <span>{msg.linkedType === 'contact' ? '👤' : '📋'} {msg.linkedName}</span>}
              {msg.comments?.length > 0 && <span>💬 {msg.comments.length}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Message Detail ---
function MessageDetail({ msg, isRecipient, isSender, canDelete, onBack, onApprove, onReject, onComment, onDelete, onEdit, onReopen, canReopen, canManageMessage, editing, setEditing, commentText, setCommentText, commentAttachment, setCommentAttachment, formatDate, formatDateTime, navigate, contacts, tasks, userId, onVote, onFileUpload, onFileDownload, onFileDelete, onPreviewFile, uploadingFile, getFileIcon, formatFileSize, isImage, scrollToComments, onEditComment, onDeleteComment, editingCommentId, setEditingCommentId, editingCommentText, setEditingCommentText, highlightedCommentId }) {
  const type = typeConfig[msg.type] || typeConfig.info;
  const status = statusConfig[msg.status] || statusConfig.pending;
  const commentsEndRef = useRef(null);

  // Auto-scroll to last comment on mount and when comments change
  useEffect(() => {
    if (commentsEndRef.current && msg.comments?.length > 0) {
      commentsEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [msg.comments?.length, scrollToComments]);

  const [editForm, setEditForm] = useState({
    subject: msg.subject || '',
    description: msg.description || '',
    type: msg.type || 'info',
    dueDate: msg.dueDate ? msg.dueDate.substring(0, 10) : '',
    linkedType: msg.linkedType || '',
    linkedId: msg.linkedId || '',
    linkedName: msg.linkedName || '',
    newAttachment: null,
    removeAttachment: false
  });

  // Reset edit form when message changes
  useEffect(() => {
    setEditForm({
      subject: msg.subject || '',
      description: msg.description || '',
      type: msg.type || 'info',
      dueDate: msg.dueDate ? msg.dueDate.substring(0, 10) : '',
      linkedType: msg.linkedType || '',
      linkedId: msg.linkedId || '',
      linkedName: msg.linkedName || '',
      newAttachment: null,
      removeAttachment: false
    });
  }, [msg]);

  const handleLinkedChangeEdit = (lType, lId) => {
    let name = '';
    if (lType === 'contact') name = contacts?.find(c => c.id === lId)?.name || '';
    if (lType === 'task') name = tasks?.find(t => t.id === lId)?.title || '';
    setEditForm(f => ({ ...f, linkedId: lId, linkedName: name }));
  };

  if (editing) {
    return (
      <div>
        <button onClick={() => setEditing(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-color)', fontSize: '14px', marginBottom: '12px' }}>
          ← Zrušiť úpravu
        </button>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '20px' }}>
          <h3 style={{ marginBottom: '16px', fontSize: '18px' }}>Upraviť správu</h3>

          {/* Type */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Typ</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {Object.entries(typeConfig).map(([key, cfg]) => (
                <button key={key} type="button"
                  onClick={() => setEditForm(f => ({ ...f, type: key }))}
                  style={{
                    padding: '6px 12px', borderRadius: 'var(--radius-sm)',
                    border: editForm.type === key ? `2px solid ${cfg.color}` : '1px solid var(--border-color)',
                    background: editForm.type === key ? `${cfg.color}15` : 'transparent',
                    cursor: 'pointer', fontSize: '13px'
                  }}>
                  {cfg.icon} {cfg.label}
                </button>
              ))}
            </div>
          </div>

          {/* Subject */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Predmet *</label>
            <input type="text" value={editForm.subject} onChange={e => setEditForm(f => ({ ...f, subject: e.target.value }))} maxLength={200}
              style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px' }} />
          </div>

          {/* Description */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Popis</label>
            <textarea value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} maxLength={5000} rows={4}
              style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px', resize: 'vertical' }} />
          </div>

          {/* Link */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Prepojenie</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <select value={editForm.linkedType} onChange={e => setEditForm(f => ({ ...f, linkedType: e.target.value, linkedId: '', linkedName: '' }))}
                style={{ padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
                <option value="">Žiadne</option>
                <option value="contact">Kontakt</option>
                <option value="task">Projekt</option>
              </select>
              {editForm.linkedType && (
                <select value={editForm.linkedId} onChange={e => handleLinkedChangeEdit(editForm.linkedType, e.target.value)}
                  style={{ flex: 1, padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
                  <option value="">Vyberte...</option>
                  {editForm.linkedType === 'contact' && contacts?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  {editForm.linkedType === 'task' && tasks?.filter(t => !t.completed).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                </select>
              )}
            </div>
          </div>

          {/* Due date */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Termín</label>
            <input type="date" value={editForm.dueDate} onChange={e => setEditForm(f => ({ ...f, dueDate: e.target.value }))}
              style={{ padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px' }} />
          </div>

          {/* Attachment */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Príloha</label>
            {msg.attachment?.originalName && !editForm.removeAttachment && !editForm.newAttachment && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', fontSize: '13px' }}>
                <span>📎 {msg.attachment.originalName}</span>
                <button onClick={() => setEditForm(f => ({ ...f, removeAttachment: true }))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: '13px' }}>× Odstrániť</button>
              </div>
            )}
            <input type="file" onChange={e => setEditForm(f => ({ ...f, newAttachment: e.target.files[0] || null, removeAttachment: false }))}
              style={{ fontSize: '13px' }} />
          </div>

          {/* Buttons */}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setEditing(false)}>Zrušiť</button>
            <button className="btn btn-primary" disabled={!editForm.subject.trim()}
              onClick={() => onEdit(msg.id || msg._id, editForm)}>
              Uložiť zmeny
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-color)', fontSize: '14px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
        ← Späť
      </button>

      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '20px', borderLeft: `4px solid ${type.color}` }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span style={{ fontSize: '18px' }}>{type.icon}</span>
              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: `${type.color}15`, color: type.color, fontWeight: 500 }}>{type.label}</span>
              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: `${status.color}15`, color: status.color, fontWeight: 500 }}>{status.icon} {status.label}</span>
            </div>
            <h3 style={{ fontSize: '18px', fontWeight: 600 }}>{msg.subject}</h3>
          </div>
          {(isSender || canDelete) && (
            <div style={{ display: 'flex', gap: '8px' }}>
              {isSender && (
                <button onClick={() => setEditing(true)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-color)', fontSize: '13px' }}>
                  ✏️ Upraviť
                </button>
              )}
              {canDelete && (
                <button onClick={() => onDelete(msg.id || msg._id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: '13px' }}>
                  🗑️ Vymazať
                </button>
              )}
            </div>
          )}
        </div>

        {/* Meta */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px', padding: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
          <div><strong>Od:</strong> {msg.fromUsername}</div>
          <div><strong>Pre:</strong> {msg.toUsername}</div>
          <div><strong>Dátum:</strong> {formatDateTime(msg.createdAt)}</div>
          {msg.dueDate && <div><strong>Termín:</strong> {formatDate(msg.dueDate)}</div>}
          {msg.linkedName && (
            <div style={{ cursor: 'pointer', color: 'var(--accent-color)' }}
              onClick={() => {
                if (msg.linkedType === 'contact') navigate(`/crm?expandContact=${msg.linkedId}`);
                if (msg.linkedType === 'task') navigate(`/tasks?highlightTask=${msg.linkedId}`);
              }}>
              <strong>{msg.linkedType === 'contact' ? '👤 Kontakt:' : '📋 Projekt:'}</strong> {msg.linkedName}
            </div>
          )}
        </div>

        {/* Description */}
        {msg.description && (
          <div style={{ marginBottom: '16px', fontSize: '14px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {linkifyText(msg.description)}
          </div>
        )}


        {/* Poll section */}
        {msg.type === 'poll' && msg.pollOptions && msg.pollOptions.length > 0 && (() => {
          const totalVotes = msg.pollOptions.reduce((sum, opt) => sum + (opt.votes?.length || 0), 0);
          const userVotedOptions = msg.pollOptions.filter(opt => opt.votes?.some(v => v.userId === userId)).map(opt => opt._id);
          const hasVoted = userVotedOptions.length > 0;
          return (
            <div style={{ marginBottom: '16px', padding: '16px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', border: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <span style={{ fontSize: '16px' }}>📊</span>
                <strong style={{ fontSize: '14px' }}>Anketa</strong>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {totalVotes} {totalVotes === 1 ? 'hlas' : totalVotes >= 2 && totalVotes <= 4 ? 'hlasy' : 'hlasov'}
                  {msg.pollMultipleChoice && ' • viacero možností'}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {msg.pollOptions.map(opt => {
                  const voteCount = opt.votes?.length || 0;
                  const pct = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
                  const isMyVote = userVotedOptions.includes(opt._id);
                  return (
                    <button key={opt._id} type="button"
                      onClick={() => onVote(msg.id || msg._id, opt._id)}
                      style={{
                        position: 'relative', textAlign: 'left', padding: '10px 14px',
                        borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                        border: isMyVote ? '2px solid var(--accent-color)' : '1px solid var(--border-color)',
                        background: 'var(--bg-card)', overflow: 'hidden', fontSize: '14px',
                        transition: 'all 0.2s ease'
                      }}>
                      <div style={{
                        position: 'absolute', top: 0, left: 0, bottom: 0,
                        width: `${pct}%`, background: isMyVote ? 'rgba(var(--accent-rgb, 99, 102, 241), 0.12)' : 'rgba(0,0,0,0.04)',
                        transition: 'width 0.3s ease', borderRadius: 'var(--radius-sm)'
                      }} />
                      <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: isMyVote ? 600 : 400 }}>
                          {isMyVote && '✓ '}{opt.text}
                        </span>
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '8px', whiteSpace: 'nowrap' }}>
                          {voteCount} ({pct}%)
                        </span>
                      </div>
                      {opt.votes?.length > 0 && (
                        <div style={{ position: 'relative', fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                          {opt.votes.map(v => v.username).join(', ')}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Files section */}
        <div className="task-files-section" style={{ marginBottom: '16px' }}>
          <div className="task-files-header">
            <span>📎 Prílohy ({(msg.files?.length || 0) + (msg.attachment?.originalName ? 1 : 0)})</span>
            {(isSender || isRecipient) && (
              <button
                className="btn btn-secondary btn-sm btn-attach"
                onClick={() => onFileUpload(msg.id || msg._id)}
                disabled={uploadingFile}
              >
                {uploadingFile ? '⏳' : '+'} Pridať
              </button>
            )}
          </div>

          {/* File list */}
          {(msg.attachment?.originalName || (msg.files && msg.files.length > 0)) && (
            <div className="task-files-list">
              {/* Legacy single attachment */}
              {msg.attachment?.originalName && (() => {
                const legacyDlUrl = `/api/messages/${msg.id || msg._id}/attachment`;
                return (
                  <div className="task-file-item">
                    <span className="task-file-icon">{getFileIcon(msg.attachment.mimetype)}</span>
                    <span className="task-file-name task-file-name-clickable" title={msg.attachment.originalName} onClick={() => onPreviewFile({ file: msg.attachment, downloadUrl: legacyDlUrl })}>{msg.attachment.originalName}</span>
                    <span className="task-file-size">{formatFileSize(msg.attachment.size)}</span>
                    <button className="btn-icon-sm" onClick={() => {
                      api.get(legacyDlUrl, { responseType: 'blob' })
                        .then(res => downloadBlob(res.data, msg.attachment.originalName));
                    }} title="Stiahnuť">⬇️</button>
                  </div>
                );
              })()}
              {/* Multi-file attachments */}
              {msg.files?.map(file => {
                const dlUrl = `/api/messages/${msg.id || msg._id}/files/${file.id}/download`;
                return (
                  <div key={file.id} className="task-file-item">
                    <span className="task-file-icon">{getFileIcon(file.mimetype)}</span>
                    <span className="task-file-name task-file-name-clickable" title={file.originalName} onClick={() => onPreviewFile({ file, downloadUrl: dlUrl })}>{file.originalName}</span>
                    <span className="task-file-size">{formatFileSize(file.size)}</span>
                    <button className="btn-icon-sm" onClick={() => onFileDownload(msg.id || msg._id, file.id, file.originalName)} title="Stiahnuť">⬇️</button>
                    {(isSender || isRecipient) && (
                      <button className="btn-icon-sm btn-delete" onClick={() => onFileDelete(msg.id || msg._id, file.id)} title="Vymazať">×</button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {uploadingFile && (
            <p style={{ fontSize: '12px', color: 'var(--accent-color)', marginTop: '4px' }}>Nahrávam súbor...</p>
          )}
        </div>

        {/* Rejection reason */}
        {msg.status === 'rejected' && msg.rejectionReason && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', fontSize: '13px' }}>
            <strong>Dôvod zamietnutia:</strong> {msg.rejectionReason}
          </div>
        )}

        {/* Actions — recipient always, or admin/manager can also approve/reject */}
        {(isRecipient || canManageMessage) && (msg.status === 'pending' || msg.status === 'commented') && (
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => onApprove(msg.id || msg._id)}
              style={{ background: 'var(--success)', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '13px' }}>
              ✅ Schváliť
            </button>
            <button className="btn" onClick={onReject}
              style={{ background: 'var(--danger)', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '13px' }}>
              ❌ Zamietnuť
            </button>
          </div>
        )}

        {/* Reopen action for admin/owner/manager */}
        {canReopen && (
          <div style={{ marginBottom: '16px' }}>
            <button className="btn" onClick={() => onReopen(msg.id || msg._id)}
              style={{ background: '#F59E0B', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              🔄 Zrušiť rozhodnutie
            </button>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Správa sa vráti do stavu {msg.comments?.length > 0 ? '"Komentované"' : '"Čaká"'} a bude možné znovu rozhodnúť.
            </p>
          </div>
        )}

        {/* Comments */}
        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
          <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>💬 Komentáre ({msg.comments?.length || 0})</h4>

          {msg.comments && msg.comments.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
              {msg.comments.map((c, i) => {
                const isOwn = (c.userId?.toString() || c.userId) === userId;
                const isEditing = editingCommentId === c._id;
                return (
                  <div key={c._id || i} id={`comment-${c._id}`} style={{ padding: '8px 12px', background: highlightedCommentId && (c._id?.toString() === highlightedCommentId?.toString()) ? 'rgba(99, 102, 241, 0.15)' : 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', fontSize: '13px', transition: 'background 0.3s', outline: highlightedCommentId && (c._id?.toString() === highlightedCommentId?.toString()) ? '2px solid #6366f1' : 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <strong>{c.username}</strong>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{formatDateTime(c.createdAt)}</span>
                        {isOwn && !isEditing && (
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button
                              onClick={() => { setEditingCommentId(c._id); setEditingCommentText(c.text); }}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontSize: '12px', color: 'var(--text-muted)', borderRadius: '4px' }}
                              title="Upraviť komentár"
                            >✏️</button>
                            <button
                              onClick={() => onDeleteComment(msg.id || msg._id, c._id)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontSize: '12px', color: 'var(--text-muted)', borderRadius: '4px' }}
                              title="Vymazať komentár"
                            >🗑️</button>
                          </div>
                        )}
                      </div>
                    </div>
                    {isEditing ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                        <textarea
                          value={editingCommentText}
                          onChange={e => { setEditingCommentText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onEditComment(msg.id || msg._id, c._id, editingCommentText); }
                            if (e.key === 'Escape') { setEditingCommentId(null); setEditingCommentText(''); }
                          }}
                          ref={el => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }}
                          style={{ width: '100%', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', resize: 'none', overflow: 'hidden', minHeight: '36px', fontFamily: 'inherit', lineHeight: '1.4' }}
                          autoFocus
                        />
                        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                          <button
                            className="btn btn-secondary"
                            onClick={() => { setEditingCommentId(null); setEditingCommentText(''); }}
                            style={{ fontSize: '12px', padding: '4px 10px', width: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}
                          >Zrušiť</button>
                          <button
                            className="btn btn-primary"
                            onClick={() => onEditComment(msg.id || msg._id, c._id, editingCommentText)}
                            disabled={!editingCommentText.trim()}
                            style={{ fontSize: '12px', padding: '4px 10px', width: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}
                          >Uložiť</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ whiteSpace: 'pre-wrap' }}>{linkifyText(c.text)}</div>
                    )}
                    {c.attachment?.originalName && (
                      <div style={{ marginTop: '6px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span>{getFileIcon(c.attachment.mimetype)}</span>
                          <span
                            className="task-file-name-clickable"
                            style={{ fontSize: '12px', color: 'var(--accent-color)', cursor: 'pointer' }}
                            onClick={() => onPreviewFile({ file: c.attachment, downloadUrl: `/api/messages/${msg.id || msg._id}/comment/${c._id}/attachment` })}
                          >
                            {c.attachment.originalName}
                          </span>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>({(c.attachment.size / 1024).toFixed(0)} KB)</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={commentsEndRef} />
            </div>
          )}

          {/* Add comment */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <textarea value={commentText} onChange={e => { setCommentText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onComment(msg.id || msg._id); } }}
              style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', resize: 'none', overflow: 'hidden', minHeight: '40px', fontFamily: 'inherit', lineHeight: '1.4' }}
              placeholder="Napíšte komentár..." rows={1} />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={() => onComment(msg.id || msg._id)}
                disabled={!commentText.trim()} style={{ fontSize: '13px', padding: '6px 14px', width: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}>
                Odoslať
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Messages;
