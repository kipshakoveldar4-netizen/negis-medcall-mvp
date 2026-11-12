export type MortgageActivityKind = "meeting" | "task";
export type MortgageActivityStatus = "open" | "in_progress" | "done" | "cancelled" | "missed";
export type MortgagePriority = "low" | "normal" | "high";

export type MortgageContact = {
  id: string; name: string; phone: string; notes: string; status: string;
  source: string; createdAt: string; updatedAt: string;
  responsibleUserId: string | null; responsibleName: string | null;
};
export type MortgageActivity = {
  id: string; kind: MortgageActivityKind; leadId: string; title: string; notes: string;
  status: MortgageActivityStatus; priority: MortgagePriority;
  startsAt: string | null; endsAt: string | null; dueAt: string | null;
  createdAt: string; updatedAt: string; contactName: string;
  responsibleUserId: string | null; responsibleName: string | null;
};
export type MortgageMember = { id: string; name: string; role: string; status: string };
export type MortgageActivityEvent = { id: string; activityId: string; action: string; title: string; actorName: string; createdAt: string };
export type MortgageMetrics = {
  totalLeads: number; unassignedLeads: number; inProgressLeads: number;
  meetingsToday: number; overdueTasks: number; activeManagers: number;
};
export type MortgageMemberMetrics = {
  id: string; name: string; role: string; assignedLeads: number;
  openTasks: number; overdueTasks: number; doneTasks: number;
  plannedMeetings: number; doneMeetings: number; missedMeetings: number;
};
export type MortgageSnapshot = {
  generatedAt: string; period: { days: number; from: string; to: string };
  timeZone: string; contacts: MortgageContact[]; contactsTotal: number;
  activities: MortgageActivity[]; activitiesTruncated: boolean;
  members: MortgageMember[]; events: MortgageActivityEvent[];
  metrics: MortgageMetrics; memberMetrics: MortgageMemberMetrics[];
  periodDays: number; page: number; pageSize: number;
};
export type MortgageActivityDraft = {
  requestId?: string;
  kind: MortgageActivityKind; leadId: string; title: string; notes?: string;
  status?: MortgageActivityStatus; priority?: MortgagePriority;
  startsAt?: string | null; endsAt?: string | null; dueAt?: string | null;
};
export type MortgageSnapshotQuery = { q?: string; page?: number; leadId?: string; from?: string; to?: string; days?: number };
