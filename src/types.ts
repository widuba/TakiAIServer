/* ============================================================================
 * Shared types for the Taki AI planner-first backend.
 *
 * Action-name contract (executed by app/src/App.tsx — do NOT rename without a
 * coordinated frontend change):
 *   compose_message, compose_email, call_phone, calendar_create,
 *   calendar_search, reminder_create, reminder_search, open_app,
 *   maps_search (field: mapsQuery), maps_directions (field: mapsDestination)
 *
 * NOTE: the product brief refers to "messages_compose" / "email_compose";
 * the shipping frontend executes "compose_message" / "compose_email". We keep
 * the executable names on the wire and the frontend now accepts both as
 * aliases (see App.tsx normalizeActionType).
 * ==========================================================================*/

export type AssistantActionType =
  | "answer_only"
  | "compose_message"
  | "call_phone"
  | "calendar_search"
  | "personal_search"
  | "calendar_create"
  | "calendar_update"
  | "calendar_delete"
  | "reminder_create"
  | "reminder_search"
  | "compose_email"
  | "open_app"
  | "maps_search"
  | "maps_directions"
  | "calendar_directions"
  | "weather_answer"
  | "live_activity"
  | "alarm_set"
  | "alarm_cancel"
  | "timer_set"
  | "timer_cancel"
  | "stopwatch_start"
  | "stopwatch_stop"
  | "contact_create"
  | "health_query"
  | "health_log"
  | "health_trend"
  | "home_control"
  | "music_control"
  | "photos_show"
  | "photos_search"
  | "day_plan"
  | "email_connect"
  | "service_handoff"
  | "list_action"
  | "expense_action"
  | "habit_action"
  | "automation_create"
  | "scheduled_message"
  | "cooking_mode"
  | "cooking_schedule"
  | "alert_create"
  | "alert_cancel"
  | "recurring_reminder"
  | "memory_save"
  | "share_content"
  | "calendar_forward";

export type AssistantAction = {
  type: AssistantActionType;
  recipientPhone: string | null;
  recipientName: string | null;
  contactQuery: string | null;
  body: string | null;
  calendarQuery: string | null;
  daysAhead: number | null;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
  notes: string | null;
  reminderQuery: string | null;
  dueDate: string | null;
  emailAddress: string | null;
  emailSubject: string | null;
  appName: string | null;
  appUrl: string | null;
  fallbackUrl: string | null;
  mapsQuery: string | null;
  mapsDestination: string | null;
  // live_activity: which flavor to start ("commute" | "countdown"). The event to
  // track is identified by `calendarQuery` / `title`; the device resolves the
  // destination + ETA and starts the activity.
  liveActivityKind: string | null;
  // commute transport mode: "driving" | "walking" | "bicycling" | "transit"
  // ("" = unspecified, device defaults to driving).
  liveActivityMode: string | null;
  // recurrence for calendar_create / reminder_create: "daily" | "weekly" |
  // "monthly" | "yearly" | "weekdays" | "" (none).
  recurrence: string | null;
  // location-based reminder: a place name; triggerOnArrival true = when you
  // arrive, false = when you leave.
  triggerLocation: string | null;
  triggerOnArrival: boolean | null;
  // health_query: "steps"|"distance"|"energy"|"exercise"|"heartrate"|"sleep".
  metric: string | null;
  // health_query day: how many days back from today (0 = today), + a label like
  // "yesterday" / "on Friday" for the spoken reply.
  healthDayOffset: number | null;
  healthDayLabel: string | null;
  // health_log: WRITE a sample. metric = "water"|"weight"|"workout"|"energy"|
  // "mindful". Value is pre-normalized (water=fl oz, weight=lb, energy=kcal);
  // workout/mindful use healthDurationMin, workouts also carry healthWorkoutType.
  healthLogMetric: string | null;
  healthLogValue: number | null;
  healthWorkoutType: string | null;
  healthDurationMin: number | null;
  // health_trend: `metric` (reused) averaged over a window vs. the prior one.
  // 7 = this week, 30 = this month.
  trendDays: number | null;
  // home_control: action ("lightsOn"|"lightsOff"|"lock"|"unlock"|"thermostat"),
  // target room (lights), value (thermostat °F).
  homeAction: string | null;
  homeTarget: string | null;
  homeValue: number | null;
  // music_control: action ("play"|"pause"|"resume"|"next"|"previous"), query.
  musicAction: string | null;
  musicQuery: string | null;
  // photos_show: how many days back (0 = just most recent).
  photoDays: number | null;
  // photos_search: content to look for on-device (e.g. "dog", "beach", "food").
  photoQuery: string | null;
  personalSearchQuery: string | null;
  // email_connect: the provider OAuth URL the device opens in the system browser.
  emailAuthUrl: string | null;
  // service_handoff: Taki fills in the details, the device deep-links into the
  // real app (Uber/DoorDash/OpenTable/…) pre-filled; the user confirms + pays
  // there. service = "uber"|"lyft"|"doordash"|"ubereats"|"grubhub"|"opentable"|
  // "resy"|"instacart"|"yelp"; kind = "ride"|"food"|"reservation"|"grocery".
  service: string | null;
  serviceKind: string | null;
  serviceLabel: string | null;      // human name for the spoken line ("Uber")
  serviceQuery: string | null;      // restaurant / food / store to search
  serviceDestination: string | null; // ride destination text (may be home/work/place)
  servicePartySize: number | null;  // reservation covers
  serviceDateTimeIso: string | null; // reservation date/time
  // list_action: device-side lists. op = "add"|"remove"|"show"|"create"|"clear"
  // |"showAll"; listName canonical ("grocery"/"to-do"); listItem for add/remove.
  listOp: string | null;
  listName: string | null;
  listItem: string | null;
  // expense_action (device-stored): op "log"|"query"; amount/category/period.
  expenseOp: string | null;
  expenseAmount: number | null;
  expenseCategory: string | null;
  expensePeriod: string | null;
  // habit_action (device-stored): op "log"|"check"|"streak"|"list"; name.
  habitOp: string | null;
  habitName: string | null;
  // Live data tracking. trackKind = finance | product | sports | flight | package.
  // trackQuery is what the device re-polls (/api/quote or /api/score) to keep the
  // activity live. The rest are the initial snapshot to display.
  trackKind: string | null;
  trackQuery: string | null;
  liveTitle: string | null;    // "AAPL", "Lakers vs Celtics"
  liveSymbol: string | null;   // SF Symbol name, e.g. "chart.line.uptrend.xyaxis"
  line1: string | null;        // primary value, e.g. "$195.20", "102 – 98"
  line2: string | null;        // secondary, e.g. "Apple Inc.", "Lakers lead"
  trend: string | null;        // "up" | "down" | "flat" (drives green/red tint)
  statusText: string | null;   // "+1.24% today", "Q4 · 2:15"
  // flight tracker: per-leg color ("green"|"yellow"|"red") for the departure
  // (line1) and arrival (line2) times.
  depColor: string | null;
  arrColor: string | null;
  // day_plan: the proposed schedule (the device confirms, then creates each).
  planItems: { type: string; title: string; startDate: string; durationMin?: number }[] | null;
  // automation_create: run `automationAction` when arriving at / leaving a place.
  automationTrigger: string | null; // "arrive" | "leave"
  automationPlace: string | null;
  automationAction: string | null;
  // memory_save: a long-term fact to append to the user's profile.
  memoryFact: string | null;
  // share_content: native iOS share sheet. Calendar shares resolve the event on
  // device; researched/current answers carry ready-to-share text.
  shareKind: string | null; // "calendar" | "calendar_list" | "text"
  shareText: string | null;
  // scheduled_message ("remind me to text Mom happy birthday at 9am") reuses
  // recipientName/contactQuery (who), body (the pre-written message), dueDate
  // (ISO fire time), and title (notification headline). No dedicated fields.
  // cooking_mode: a guided recipe the device walks the user through step by step
  // (each step can carry an optional timer in minutes).
  recipe: {
    title: string;
    servings: string;
    totalTime: string;
    ingredients: string[];
    steps: { instruction: string; timerMin?: number }[];
  } | null;
  // alert_create / alert_cancel: a proactive server-watched alert. alertKind
  // "price" (alertQuery + alertTarget + alertDirection) or "score" (alertQuery +
  // alertTrigger "final"|"any"). The device registers/cancels it via /api/alerts.
  alertKind: string | null;
  alertQuery: string | null;
  alertTarget: number | null;
  alertDirection: string | null;
  alertTrigger: string | null;
  // recurring_reminder: a repeating local notification the device schedules.
  recurKind: string | null;          // "daily" | "weekly" | "interval"
  recurHour: number | null;
  recurMinute: number | null;
  recurWeekdays: number[] | null;    // 1=Sun … 7=Sat
  recurIntervalMinutes: number | null;
  recurIsBriefing: boolean | null;
};

export type DeviceLocation = {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
};

// Re-export the message-style types so the rest of the backend imports them
// from one place alongside the other shared types.
export type {
  MessageStyleVector,
  IncomingStyleProfile,
  MessageAnalysis
} from "./messageStyle.js";

/* ---- Structured conversational memory ----------------------------------- */

// A real-world event the user discussed or that we scheduled. confidence helps
// downstream decide how much to trust a transcript-extracted event vs a
// grounded web event vs older saved memory.
export type EventMemory = {
  title: string;
  startDate: string;
  endDate: string;
  location?: string;
  notes?: string;
  source?: string; // web | chat-transcript | message | calendar_create | saved-memory
  confidence: number;
};

export type ContactMemory = {
  name?: string;
  phone?: string;
  email?: string;
  source?: string;
  confidence?: number;
};

export type PlaceMemory = {
  label: string;
  query?: string;
  address?: string;
  source?: string;
  confidence?: number;
};

// When the assistant has to ask for missing info, it parks the half-built
// action here so the NEXT user message can complete it (test case F).
export type PendingClarification = {
  intent: string;
  missing: string[];
  draftAction: Partial<AssistantAction> | null;
  question: string;
  createdAt: string;
};

export type AssistantMemory = {
  lastTopic?: string | null;
  lastAnswer?: string | null;
  lastIntent?: string | null;
  lastMentionedEvent?: EventMemory | null;
  lastMentionedContact?: ContactMemory | null;
  lastMentionedPlace?: PlaceMemory | null;
  pendingClarification?: PendingClarification | null;

  // Legacy fields kept so older frontend builds keep working. lastEvent always
  // mirrors lastMentionedEvent.
  lastEvent?: EventMemory | null;
  lastMessageDraft?: {
    recipientName?: string | null;
    contactQuery?: string | null;
    body?: string | null;
  } | null;
  lastEmailDraft?: {
    recipientName?: string | null;
    contactQuery?: string | null;
    emailAddress?: string | null;
    subject?: string | null;
    body?: string | null;
  } | null;
  lastLocation?: {
    label?: string | null;
    query?: string | null;
  } | null;
};

// The wire response returned to the frontend.
export type AssistantResponse = {
  spokenText: string;
  action: AssistantAction | null;
  sources?: AssistantSource[];
  comparison?: AssistantComparison;
  // Present (length > 1) when the request produced several actions to run.
  actions?: AssistantAction[] | null;
  memory?: AssistantMemory | null;
  followUpEvent?: EventMemory | null; // legacy mirror of memory.lastMentionedEvent
  // Style metadata for the just-composed message; the frontend renders feedback
  // controls from it and learns the recipient's profile.
  messageAnalysis?: import("./messageStyle.js").MessageAnalysis | null;
  debug?: any;
};

export type AssistantSource = {
  title: string;
  url: string;
};

export type AssistantComparison = {
  title: string;
  criteria: string[];
  items: { name: string; values: string[] }[];
  summary: string;
};

/* ---- Conversation state (built per request) ----------------------------- */

export type TranscriptTurn = {
  role: "user" | "assistant";
  text: string;
};

export type ConversationState = {
  message: string;
  transcript: TranscriptTurn[];
  // Transcript text with assistant "Added .../I'll add ..." confirmation lines
  // removed — used for event reasoning so we never re-schedule from them.
  eventTranscriptText: string;
  // Full transcript text — used for general Q&A about earlier statements.
  fullTranscriptText: string;
  // A tiny recency-oriented digest used to resolve elliptical follow-ups without
  // making the model hunt through the whole transcript.
  conversationFocusText: string;
  correctionsText: string;
  nowIso: string;
  timeZone: string;

  // Saved-memory fallbacks (decoded from the round-tripped follow-up context).
  // The current transcript always outranks these.
  priorEvent: EventMemory | null;
  priorContact: ContactMemory | null;
  priorPlace: PlaceMemory | null;
  pendingClarification: PendingClarification | null;
  priorMemory: AssistantMemory;

  deviceLocation?: DeviceLocation;

  // Style vectors for recipients named in THIS message only (device-stored
  // profiles, sent per-request). Empty when nothing has been learned yet.
  styleProfiles: import("./messageStyle.js").IncomingStyleProfile[];

  // Who the user is + how they want the assistant to talk (device-stored).
  userProfile: import("./persona.js").UserPersona;

  // True when this turn came in over voice (STT→brain→TTS). Generation is kept
  // extra-brief so replies are cheap to synthesize and fast to hear aloud.
  voiceMode?: boolean;

  // The 8-digit device identity (empty for older unmetered builds). Scopes the
  // per-device durable state the planner reads/writes — e.g. custom home
  // routines.
  deviceId?: string;
};

/* ---- Planner output ----------------------------------------------------- */

export type PlannerIntent =
  | "answer_only"
  | "web_search"
  | "event_lookup"
  | "compose_message"
  | "compose_email"
  | "call_phone"
  | "calendar_create"
  | "calendar_create_from_context"
  | "calendar_update"
  | "calendar_delete"
  | "reminder_create"
  | "reminder_search"
  | "calendar_search"
  | "personal_search"
  | "open_app"
  | "maps_search"
  | "maps_directions"
  | "calendar_directions"
  | "weather_answer"
  | "location_answer"
  | "contact_create"
  | "health_query"
  | "music_control"
  | "home_control"
  | "photos_show"
  | "share_content"
  | "calendar_forward"
  | "clarify";

// Raw structured output from the planner model. Everything is best-effort and
// gets cleaned by the deterministic validators before use.
export type PlannerModelOutput = {
  intent: PlannerIntent;
  spokenText: string;
  confidence: number;
  needsClarification: boolean;
  clarifyingQuestion: string | null;
  missing: string[];
  webQuery: string | null;
  // For research-backed messages/emails: what to look up to fill the body
  // (e.g. "next Atlanta Braves game date, time, venue"). null when not needed.
  researchQuery: string | null;
  wantsCalendar: boolean;
  event: Partial<EventMemory> | null;
  action: Partial<AssistantAction> | null;
  contact: ContactMemory | null;
  place: PlaceMemory | null;
};

// What planAssistantResponse returns. finalizeResponse turns this into the
// AssistantResponse wire shape and enforces the spoken/action invariants.
export type MemoryPatch = {
  lastMentionedEvent?: EventMemory;
  lastMentionedContact?: ContactMemory;
  lastMentionedPlace?: PlaceMemory;
  pendingClarification?: PendingClarification | null;
  lastIntent?: string;
};

export type AssistantPlan = {
  spokenText: string;
  action: AssistantAction | null;
  confidence?: number;
  sources?: AssistantSource[];
  comparison?: AssistantComparison;
  // When a single request maps to several actions (e.g. "add the next 3 games"),
  // they go here. `action` mirrors actions[0] for back-compat.
  actions?: AssistantAction[] | null;
  memoryPatch: MemoryPatch;
  needsExecution: boolean;
  // Per-recipient style analysis, set only for compose_message plans.
  messageAnalysis?: import("./messageStyle.js").MessageAnalysis | null;
  debug?: any;
};

export function blankAction(type: AssistantActionType): AssistantAction {
  return {
    type,
    recipientPhone: null,
    recipientName: null,
    contactQuery: null,
    body: null,
    calendarQuery: null,
    daysAhead: null,
    title: null,
    startDate: null,
    endDate: null,
    location: null,
    notes: null,
    reminderQuery: null,
    dueDate: null,
    emailAddress: null,
    emailSubject: null,
    appName: null,
    appUrl: null,
    fallbackUrl: null,
    mapsQuery: null,
    mapsDestination: null,
    liveActivityKind: null,
    liveActivityMode: null,
    recurrence: null,
    triggerLocation: null,
    triggerOnArrival: null,
    metric: null,
    homeAction: null,
    homeTarget: null,
    homeValue: null,
    musicAction: null,
    musicQuery: null,
    healthDayOffset: null,
    healthDayLabel: null,
    healthLogMetric: null,
    healthLogValue: null,
    healthWorkoutType: null,
    healthDurationMin: null,
    trendDays: null,
    photoDays: null,
    photoQuery: null,
    personalSearchQuery: null,
    emailAuthUrl: null,
    service: null,
    serviceKind: null,
    serviceLabel: null,
    serviceQuery: null,
    serviceDestination: null,
    servicePartySize: null,
    serviceDateTimeIso: null,
    listOp: null,
    listName: null,
    listItem: null,
    expenseOp: null,
    expenseAmount: null,
    expenseCategory: null,
    expensePeriod: null,
    habitOp: null,
    habitName: null,
    trackKind: null,
    trackQuery: null,
    liveTitle: null,
    liveSymbol: null,
    line1: null,
    line2: null,
    trend: null,
    statusText: null,
    depColor: null,
    arrColor: null,
    planItems: null,
    automationTrigger: null,
    automationPlace: null,
    automationAction: null,
    memoryFact: null,
    shareKind: null,
    shareText: null,
    recipe: null,
    alertKind: null,
    alertQuery: null,
    alertTarget: null,
    alertDirection: null,
    alertTrigger: null,
    recurKind: null,
    recurHour: null,
    recurMinute: null,
    recurWeekdays: null,
    recurIntervalMinutes: null,
    recurIsBriefing: null
  };
}
