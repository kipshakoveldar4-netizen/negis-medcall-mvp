import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, Plus, Send, Users, UserPlus, Search, X } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { agentDisplayName, agentInitials, loadAgentRoleMaps } from '@/lib/agentDisplay';
import { toast } from 'sonner';

interface Agent {
  id: string;
  name: string;
  user_id: string | null;
  role_id?: string | null;
  avatar_url?: string | null;
  avatar_icon?: string | null;
  avatar_color?: string | null;
}

interface Conversation {
  id: string;
  type: 'direct' | 'group';
  title: string;
  memberIds: string[];
  createdAt: string;
}

interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderAgentId?: string | null;
  senderName: string;
  text: string;
  createdAt: string;
}

const conversationsKey = (clinicId: string | null) => `negis_chat_conversations_${clinicId ?? 'default'}`;
const messagesKey = (clinicId: string | null) => `negis_chat_messages_${clinicId ?? 'default'}`;

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || '') as T;
  } catch {
    return fallback;
  }
}

export default function Chat() {
  const { clinicId, user } = useAuth();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [customRoleMap, setCustomRoleMap] = useState<Record<string, string>>({});
  const [userRoleMap, setUserRoleMap] = useState<Record<string, string>>({});
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeId, setActiveId] = useState('');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupMembers, setGroupMembers] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  const [dbReady, setDbReady] = useState(true);
  const [loading, setLoading] = useState(false);

  const meId = user?.id ?? 'me';
  const meName = user?.user_metadata?.full_name || user?.email || 'Я';

  useEffect(() => {
    if (!clinicId) return;
    loadAgents();
  }, [clinicId]);

  useEffect(() => {
    if (!hydrated || !clinicId || dbReady) return;
    localStorage.setItem(conversationsKey(clinicId), JSON.stringify(conversations));
  }, [conversations, clinicId, hydrated, dbReady]);

  useEffect(() => {
    if (!hydrated || !clinicId || dbReady) return;
    localStorage.setItem(messagesKey(clinicId), JSON.stringify(messages));
  }, [messages, clinicId, hydrated, dbReady]);

  const loadAgents = async () => {
    if (!clinicId) return;
    setLoading(true);
    const primary = await supabase
      .from('agents')
      .select('id, name, user_id, role_id, avatar_url, avatar_icon, avatar_color')
      .eq('clinic_id', clinicId)
      .order('name');
    let data = primary.data as Agent[] | null;
    let error = primary.error;
    if (error) {
      const fallback = await supabase
        .from('agents')
        .select('id, name, user_id, role_id')
        .eq('clinic_id', clinicId)
        .order('name');
      data = fallback.data as Agent[] | null;
      error = fallback.error;
    }
    if (error) {
      toast.error(error.message);
      return;
    }
    const rows = (data ?? []) as Agent[];
    const maps = await loadAgentRoleMaps(supabase, clinicId, rows);
    setAgents(rows);
    setCustomRoleMap(maps.customRoleMap);
    setUserRoleMap(maps.userRoleMap);
    await loadChatRows(rows);
    setLoading(false);
  };

  const loadLocalChat = () => {
    setConversations(readJson<Conversation[]>(conversationsKey(clinicId), []));
    setMessages(readJson<ChatMessage[]>(messagesKey(clinicId), []));
    setHydrated(true);
  };

  const loadChatRows = async (agentRows: Agent[]) => {
    if (!clinicId) return;
    const { data: convRows, error: convError } = await supabase
      .from('chat_conversations')
      .select('id, type, title, created_at')
      .eq('clinic_id', clinicId)
      .order('updated_at', { ascending: false });

    if (convError) {
      setDbReady(false);
      loadLocalChat();
      return;
    }

    const conversationIds = (convRows ?? []).map(row => row.id);
    const [{ data: memberRows }, { data: messageRows }] = await Promise.all([
      conversationIds.length
        ? supabase.from('chat_members').select('conversation_id, agent_id').in('conversation_id', conversationIds)
        : Promise.resolve({ data: [] }),
      conversationIds.length
        ? supabase.from('chat_messages').select('id, conversation_id, sender_agent_id, sender_user_id, body, created_at').in('conversation_id', conversationIds).order('created_at')
        : Promise.resolve({ data: [] }),
    ]);

    const byConversation = new Map<string, string[]>();
    for (const member of memberRows ?? []) {
      const list = byConversation.get(member.conversation_id) ?? [];
      if (member.agent_id) list.push(member.agent_id);
      byConversation.set(member.conversation_id, list);
    }

    const nextConversations: Conversation[] = (convRows ?? []).map(row => ({
      id: row.id,
      type: row.type,
      title: row.title,
      memberIds: byConversation.get(row.id) ?? [],
      createdAt: row.created_at,
    }));
    const nextMessages: ChatMessage[] = (messageRows ?? []).map(row => {
      const sender = agentRows.find(agent => agent.id === row.sender_agent_id) ?? agentRows.find(agent => agent.user_id === row.sender_user_id);
      return {
        id: row.id,
        conversationId: row.conversation_id,
        senderId: row.sender_user_id ?? row.sender_agent_id ?? '',
        senderAgentId: row.sender_agent_id,
        senderName: sender ? agentLabel(sender) : 'Сотрудник',
        text: row.body,
        createdAt: row.created_at,
      };
    });

    setDbReady(true);
    setConversations(nextConversations);
    setMessages(nextMessages);
    setActiveId(prev => prev || nextConversations[0]?.id || '');
    setHydrated(true);
  };

  const agentLabel = (agent: Agent | null | undefined) => agentDisplayName(agent, customRoleMap, userRoleMap);
  const myAgent = agents.find(agent => agent.user_id === user?.id) ?? null;
  const active = conversations.find(conversation => conversation.id === activeId) ?? conversations[0] ?? null;
  const activeMessages = active ? messages.filter(message => message.conversationId === active.id) : [];

  const filteredAgents = agents.filter(agent =>
    agentLabel(agent).toLowerCase().includes(search.toLowerCase()) ||
    agent.name.toLowerCase().includes(search.toLowerCase())
  );

  const filteredConversations = useMemo(() => {
    if (!search.trim()) return conversations;
    const needle = search.toLowerCase();
    return conversations.filter(conversation =>
      conversation.title.toLowerCase().includes(needle) ||
      conversation.memberIds.some(id => agentLabel(agents.find(agent => agent.id === id)).toLowerCase().includes(needle))
    );
  }, [search, conversations, agents, customRoleMap, userRoleMap]);

  const createDirect = (agent: Agent) => {
    const existing = conversations.find(conversation => conversation.type === 'direct' && conversation.memberIds.includes(agent.id));
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      type: 'direct',
      title: agentLabel(agent),
      memberIds: [agent.id],
      createdAt: new Date().toISOString(),
    };
    if (dbReady && clinicId) {
      createConversationInDb(conversation, [agent.id, myAgent?.id].filter(Boolean) as string[]);
      return;
    }
    setConversations(prev => [conversation, ...prev]);
    setActiveId(conversation.id);
  };

  const createConversationInDb = async (conversation: Conversation, memberIds: string[]) => {
    if (!clinicId) return;
    const uniqueMemberIds = Array.from(new Set(memberIds));
    const { data, error } = await supabase
      .from('chat_conversations')
      .insert({
        clinic_id: clinicId,
        type: conversation.type,
        title: conversation.title,
        created_by: user?.id ?? null,
      })
      .select('id, type, title, created_at')
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }

    if (uniqueMemberIds.length) {
      const { error: memberError } = await supabase.from('chat_members').insert(uniqueMemberIds.map(agentId => {
        const member = agents.find(item => item.id === agentId);
        return {
          clinic_id: clinicId,
          conversation_id: data.id,
          agent_id: agentId,
          user_id: member?.user_id ?? null,
        };
      }));
      if (memberError) toast.error(memberError.message);
    }

    const next: Conversation = {
      id: data.id,
      type: data.type,
      title: data.title,
      memberIds: uniqueMemberIds,
      createdAt: data.created_at,
    };
    setConversations(prev => [next, ...prev]);
    setActiveId(next.id);
  };

  const openGroupModal = () => {
    setGroupTitle('');
    setGroupMembers(new Set());
    setShowGroupModal(true);
  };

  const createGroup = () => {
    if (!groupTitle.trim()) {
      toast.error('Введите название группы');
      return;
    }
    if (groupMembers.size === 0) {
      toast.error('Выберите сотрудников');
      return;
    }
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      type: 'group',
      title: groupTitle.trim(),
      memberIds: Array.from(new Set([...groupMembers, myAgent?.id].filter(Boolean) as string[])),
      createdAt: new Date().toISOString(),
    };
    if (dbReady && clinicId) {
      createConversationInDb(conversation, conversation.memberIds);
      setShowGroupModal(false);
      return;
    }
    setConversations(prev => [conversation, ...prev]);
    setActiveId(conversation.id);
    setShowGroupModal(false);
  };

  const toggleMember = (agentId: string) => {
    setGroupMembers(prev => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const inviteToActive = (agentId: string) => {
    if (!active || active.type !== 'group') return;
    if (dbReady && clinicId) {
      const member = agents.find(agent => agent.id === agentId);
      supabase.from('chat_members').insert({
        clinic_id: clinicId,
        conversation_id: active.id,
        agent_id: agentId,
        user_id: member?.user_id ?? null,
      }).then(({ error }) => {
        if (error) toast.error(error.message);
      });
    }
    setConversations(prev => prev.map(conversation =>
      conversation.id === active.id && !conversation.memberIds.includes(agentId)
        ? { ...conversation, memberIds: [...conversation.memberIds, agentId] }
        : conversation
    ));
  };

  const sendMessage = () => {
    if (!active || !draft.trim()) return;
    const text = draft.trim();
    if (dbReady && clinicId) {
      supabase
        .from('chat_messages')
        .insert({
          clinic_id: clinicId,
          conversation_id: active.id,
          sender_agent_id: myAgent?.id ?? null,
          sender_user_id: user?.id ?? null,
          body: text,
        })
        .select('id, conversation_id, sender_agent_id, sender_user_id, body, created_at')
        .single()
        .then(({ data, error }) => {
          if (error) {
            toast.error(error.message);
            return;
          }
          setMessages(prev => [...prev, {
            id: data.id,
            conversationId: data.conversation_id,
            senderId: data.sender_user_id ?? data.sender_agent_id ?? meId,
            senderAgentId: data.sender_agent_id,
            senderName: myAgent ? agentLabel(myAgent) : meName,
            text: data.body,
            createdAt: data.created_at,
          }]);
        });
      setDraft('');
      return;
    }
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      conversationId: active.id,
      senderId: meId,
      senderAgentId: myAgent?.id,
      senderName: meName,
      text,
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, message]);
    setDraft('');
  };

  const Avatar = ({ agent, fallback }: { agent?: Agent | null; fallback?: string }) => (
    <div
      className="h-10 w-10 shrink-0 overflow-hidden rounded-2xl border border-[#E3EAF2] flex items-center justify-center font-black text-[#1E325C]"
      style={{ background: agent?.avatar_color || '#EFF6FF' }}
    >
      {agent?.avatar_url ? (
        <img src={agent.avatar_url} alt={agent.name} className="h-full w-full object-cover" />
      ) : agent?.avatar_icon ? (
        <span className="text-lg">{agent.avatar_icon}</span>
      ) : (
        agentInitials(agent, fallback)
      )}
    </div>
  );

  return (
    <PageLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-[#0B1220]">Чат</h2>
            <p className="text-sm text-[#64748B] mt-1">
              Личные сообщения и групповые обсуждения сотрудников
              {!dbReady && <span className="ml-2 text-[#D97706]">локальный режим до применения SQL</span>}
            </p>
          </div>
          <button className="neu-btn-primary" onClick={openGroupModal}>
            <Plus size={16} />
            Групповой чат
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[340px_1fr_300px] gap-5 min-h-[calc(100dvh-230px)]">
          <aside className="neu-card p-0 overflow-hidden flex flex-col">
            <div className="p-4 border-b border-[#E3EAF2]">
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8EA0B7]" />
                <input
                  className="neu-input pl-9"
                  placeholder="Поиск чатов"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            </div>
            <div className="overflow-y-auto p-3 space-y-2">
              {loading ? (
                <div className="text-sm text-[#94A3B8] p-4 text-center">Загрузка...</div>
              ) : filteredConversations.length === 0 ? (
                <div className="text-sm text-[#94A3B8] p-4 text-center">Чатов пока нет</div>
              ) : filteredConversations.map(conversation => {
                const last = [...messages].reverse().find(message => message.conversationId === conversation.id);
                const isActive = active?.id === conversation.id;
                const directAgent = conversation.type === 'direct'
                  ? agents.find(agent => conversation.memberIds.includes(agent.id) && agent.id !== myAgent?.id) ?? agents.find(agent => conversation.memberIds.includes(agent.id))
                  : null;
                return (
                  <button
                    key={conversation.id}
                    className={`w-full text-left rounded-2xl border p-4 transition ${isActive ? 'border-[#1E325C] bg-[#EFF6FF]' : 'border-[#E3EAF2] bg-white/70 hover:bg-white'}`}
                    onClick={() => setActiveId(conversation.id)}
                  >
                    <div className="flex items-center gap-3">
                      {conversation.type === 'group'
                        ? (
                          <div className="h-10 w-10 rounded-2xl flex items-center justify-center bg-purple-100 text-purple-700">
                            <Users size={18} />
                          </div>
                        )
                        : <Avatar agent={directAgent} fallback={conversation.title} />}
                      <div className="min-w-0">
                        <div className="font-bold text-[#0B1220] truncate">{conversation.title}</div>
                        <div className="text-xs text-[#94A3B8] truncate">{last?.text || `${conversation.memberIds.length} участников`}</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="neu-card p-0 overflow-hidden flex flex-col min-h-[560px]">
            {active ? (
              <>
                <div className="px-5 py-4 border-b border-[#E3EAF2] flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-black text-[#0B1220]">{active.title}</h3>
                    <p className="text-xs text-[#64748B] mt-0.5">
                      {active.type === 'group' ? `${active.memberIds.length} участников` : 'Личный чат'}
                    </p>
                  </div>
                  {active.type === 'group' && <UserPlus size={18} className="text-[#64748B]" />}
                </div>
                <div className="flex-1 overflow-y-auto p-5 space-y-3">
                  {activeMessages.length === 0 ? (
                    <div className="h-full min-h-[360px] flex items-center justify-center text-sm text-[#94A3B8]">
                      Напишите первое сообщение
                    </div>
                  ) : activeMessages.map(message => {
                    const mine = message.senderId === meId;
                    return (
                      <div key={message.id} className={`flex items-end gap-2 ${mine ? 'justify-end' : 'justify-start'}`}>
                        {!mine && <Avatar agent={agents.find(agent => agent.id === message.senderAgentId)} fallback={message.senderName} />}
                        <div className={`max-w-[72%] rounded-2xl px-4 py-3 shadow-sm ${mine ? 'bg-[#1E325C] text-white' : 'bg-white border border-[#E3EAF2] text-[#0B1220]'}`}>
                          <div className={`text-[11px] font-semibold mb-1 ${mine ? 'text-white/70' : 'text-[#8EA0B7]'}`}>{message.senderName}</div>
                          <div className="text-sm whitespace-pre-wrap">{message.text}</div>
                          <div className={`text-[10px] mt-2 ${mine ? 'text-white/55' : 'text-[#CBD5E1]'}`}>
                            {new Date(message.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                        {mine && <Avatar agent={myAgent} fallback={meName} />}
                      </div>
                    );
                  })}
                </div>
                <div className="p-4 border-t border-[#E3EAF2] flex gap-3">
                  <textarea
                    className="neu-input min-h-[46px] max-h-32 resize-y"
                    placeholder="Сообщение..."
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                  />
                  <button className="neu-btn-primary self-end h-[46px]" onClick={sendMessage}>
                    <Send size={16} />
                  </button>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-[#94A3B8] text-sm">
                Выберите сотрудника или создайте групповой чат
              </div>
            )}
          </section>

          <aside className="neu-card p-0 overflow-hidden flex flex-col">
            <div className="p-4 border-b border-[#E3EAF2]">
              <h3 className="font-bold text-[#0B1220]">Сотрудники</h3>
              <p className="text-xs text-[#94A3B8] mt-0.5">ЛС или приглашение в группу</p>
            </div>
            <div className="p-3 space-y-2 overflow-y-auto">
              {filteredAgents.map(agent => {
                const invited = active?.memberIds.includes(agent.id);
                return (
                  <div key={agent.id} className="rounded-2xl border border-[#E3EAF2] bg-white/70 p-3">
                    <div className="flex items-center gap-3">
                      <Avatar agent={agent} />
                      <div className="font-bold text-sm text-[#0B1220]">{agentLabel(agent)}</div>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button className="neu-btn flex-1" style={{ padding: '7px 10px', fontSize: 12 }} onClick={() => createDirect(agent)}>
                        ЛС
                      </button>
                      <button
                        className="neu-btn flex-1"
                        style={{ padding: '7px 10px', fontSize: 12 }}
                        disabled={!active || active.type !== 'group' || invited}
                        onClick={() => inviteToActive(agent.id)}
                      >
                        {invited ? 'В чате' : 'Пригласить'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        </div>
      </div>

      {showGroupModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm p-4" onClick={e => {
          if (e.target === e.currentTarget) setShowGroupModal(false);
        }}>
          <div className="soft-modal w-full max-w-lg p-6">
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-lg font-black text-[#0B1220]">Новый групповой чат</h3>
              <button className="soft-icon-btn" onClick={() => setShowGroupModal(false)}>
                <X size={16} />
              </button>
            </div>
            <input
              className="neu-input mb-4"
              placeholder="Название группы"
              value={groupTitle}
              onChange={e => setGroupTitle(e.target.value)}
            />
            <div className="max-h-72 overflow-y-auto space-y-2">
              {agents.map(agent => (
                <label key={agent.id} className="flex items-center gap-3 rounded-2xl border border-[#E3EAF2] bg-white/70 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={groupMembers.has(agent.id)}
                    onChange={() => toggleMember(agent.id)}
                    style={{ width: 16, height: 16, accentColor: '#1E325C' }}
                  />
                  <span className="font-semibold text-sm text-[#0B1220]">{agentLabel(agent)}</span>
                </label>
              ))}
            </div>
            <div className="mt-5 flex gap-3">
              <button className="neu-btn flex-1" onClick={() => setShowGroupModal(false)}>Отмена</button>
              <button className="neu-btn-primary flex-1" onClick={createGroup}>Создать</button>
            </div>
          </div>
        </div>
      )}
    </PageLayout>
  );
}
