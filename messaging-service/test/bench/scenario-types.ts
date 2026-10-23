export interface MessageSpec {
  text?: string;
  sticker?: boolean;
  audio?: boolean;
  reaction?: string;
  image?: { caption?: string };
}

export interface TurnSpec {
  actor: string;
  messages: MessageSpec[];
  concurrentWithPrevious?: boolean;
  expect?: { route?: string };
}

export interface Scenario {
  id: string;
  category: string;
  title: string;
  knownFailure?: string;
  prior?: {
    client?: { name: string; birthDate: string };
    reservations?: unknown[];
  };
  turns: TurnSpec[];
  expect: ScenarioExpect;
}

export interface ScenarioExpect {
  route?: string;
  toolsAny?: string[];
  toolsAll?: string[];
  toolsForbidden?: string[];
  replyMatches?: string;
  replyNotMatches?: string;
  replyShowsToday?: boolean;
  finalState?: { reservationStatus?: string; reservationCountAtLeast?: number };
  noFalseHumanPromise?: boolean;
  notCutOrEmpty?: boolean;
  noCrossTalk?: boolean;
  everyActorAnswered?: boolean;
}
