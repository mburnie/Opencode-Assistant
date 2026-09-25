import type {
  FormInfo,
  FormField,
  FormOption,
} from "@opencode/client/promise";

export type { FormInfo, FormField, FormOption };

export type FieldAnswerValue =
  | string
  | number
  | boolean
  | string[];

export interface FormAnswer {
  key: string;
  value: FieldAnswerValue;
}

export interface FormState {
  form: FormInfo | null;
  currentFieldIndex: number;
  answers: Map<string, FieldAnswerValue>;
  activeMessageId: number | null;
  messageIds: number[];
  isActive: boolean;
  customInputFieldIndex: number | null;
  selectedOptions: Map<number, Set<number>>;
}
