import type {
  Expense,
  Filter,
  ParsedListExpenses,
  Cursor,
  CorrectionMatch,
} from '../domain/expense';
import type { Recurring } from '../domain/planning';
import type { PlanningStore } from '../planning/store';
import type { DuplicateProbe } from './duplicates';
import type { AccountStore } from '../planning/account-store';
import type { Activity, BackupDataset, HistoryInput, Report, ReportRow } from '../domain/insights';

export type Mutation = {
  ownerId: string;
  key: string;
  hash: string;
  after: Expense;
  duplicateConfirmation?: { id: string; version: number }[];
  schedule?: { before: Recurring; after: Recurring };
  restore?: boolean;
} & ({ before: null; match?: never } | { before: Expense; match: CorrectionMatch });
export type LedgerStore = PlanningStore &
  AccountStore & {
    findDuplicates(ownerId: string, probe: DuplicateProbe): Promise<Expense[]>;
    findMutation(
      ownerId: string,
      key: string,
    ): Promise<{ hash: string; after: Expense } | undefined>;
    findOccurrence(
      ownerId: string,
      recurringId: string,
      occurrenceDate: string,
    ): Promise<Expense | undefined>;
    findExpense(ownerId: string, id: string): Promise<Expense | undefined>;
    findCorrectionMatches(
      ownerId: string,
      match: CorrectionMatch,
      deleted?: boolean,
    ): Promise<Expense[]>;
    commit(mutation: Mutation): Promise<void>;
    list(ownerId: string, filter: ParsedListExpenses, cursor?: Cursor): Promise<Expense[]>;
    totals(
      ownerId: string,
      filter: Filter,
    ): Promise<
      {
        type: Expense['type'];
        currency: Expense['currency'];
        minor: string;
        count: number;
        unverifiedCount: number;
      }[]
    >;
    exportPage(
      ownerId: string,
      type: Expense['type'] | undefined,
      limit: number,
      cursor?: { createdAt: string; id: string },
    ): Promise<Expense[]>;
    report(ownerId: string, input: Report, previousFrom?: string): Promise<ReportRow[]>;
    history(ownerId: string, input: HistoryInput): Promise<Activity[]>;
    exportDataset(
      ownerId: string,
      dataset: Exclude<BackupDataset, 'entries'>,
      limit: number,
      after?: string,
    ): Promise<{ key: string; record: Record<string, unknown> }[]>;
  };
