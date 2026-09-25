import type {
  FormInfo,
  FormField,
  FormOption,
  FieldAnswerValue,
  FormState,
} from "./types.js";
import { logger } from "../utils/logger.js";

class FormManager {
  private state: FormState = {
    form: null,
    currentFieldIndex: 0,
    answers: new Map(),
    activeMessageId: null,
    messageIds: [],
    isActive: false,
    customInputFieldIndex: null,
    selectedOptions: new Map(),
  };

  startForm(form: FormInfo): void {
    logger.debug(
      `[FormManager] startForm called: isActive=${this.state.isActive}, fields=${form.fields.length}, formID=${form.id}`,
    );

    if (this.state.isActive) {
      logger.info(`[FormManager] Form already active! Forcing reset before starting new form.`);
      this.clear();
    }

    logger.info(
      `[FormManager] Starting new form with ${form.fields.length} fields, formID=${form.id}`,
    );

    this.state = {
      form,
      currentFieldIndex: 0,
      answers: new Map(),
      activeMessageId: null,
      messageIds: [],
      isActive: true,
      customInputFieldIndex: null,
      selectedOptions: new Map(),
    };
  }

  getForm(): FormInfo | null {
    return this.state.form;
  }

  getFormId(): string | null {
    return this.state.form?.id ?? null;
  }

  getSessionID(): string | null {
    return this.state.form?.sessionID ?? null;
  }

  getCurrentField(): FormField | null {
    if (!this.state.form) {
      return null;
    }
    if (this.state.currentFieldIndex >= this.state.form.fields.length) {
      return null;
    }
    return this.state.form.fields[this.state.currentFieldIndex];
  }

  getCurrentFieldIndex(): number {
    return this.state.currentFieldIndex;
  }

  getTotalFields(): number {
    return this.state.form?.fields.length ?? 0;
  }

  hasNextField(): boolean {
    if (!this.state.form) {
      return false;
    }
    return this.state.currentFieldIndex < this.state.form.fields.length;
  }

  nextField(): void {
    this.state.currentFieldIndex++;
    this.state.customInputFieldIndex = null;
    this.state.activeMessageId = null;

    logger.debug(
      `[FormManager] Moving to next field: ${this.state.currentFieldIndex}/${this.state.form?.fields.length ?? 0}`,
    );
  }

  selectOption(fieldIndex: number, optionIndex: number): void {
    if (!this.state.isActive) {
      return;
    }

    const field = this.state.form?.fields[fieldIndex];
    if (!field) {
      return;
    }

    const selected = this.state.selectedOptions.get(fieldIndex) || new Set<number>();

    if (field.type === "multiselect") {
      if (selected.has(optionIndex)) {
        selected.delete(optionIndex);
      } else {
        selected.add(optionIndex);
      }
    } else if (field.type === "string" && field.options && field.options.length > 0) {
      selected.clear();
      selected.add(optionIndex);
    } else {
      return;
    }

    this.state.selectedOptions.set(fieldIndex, selected);

    logger.debug(
      `[FormManager] Selected options for field ${fieldIndex}: ${Array.from(selected).join(", ")}`,
    );
  }

  getSelectedOptions(fieldIndex: number): Set<number> {
    return this.state.selectedOptions.get(fieldIndex) || new Set();
  }

  getSelectedAnswer(fieldIndex: number): FieldAnswerValue | undefined {
    const field = this.state.form?.fields[fieldIndex];
    if (!field) {
      return undefined;
    }

    if (field.type === "multiselect") {
      const selected = this.state.selectedOptions.get(fieldIndex) || new Set();
      const options = field.options;
      const labels = Array.from(selected)
        .map((idx) => options[idx]?.value)
        .filter((value): value is string => typeof value === "string");
      return labels;
    }

    if (field.type === "string" && field.options && field.options.length > 0) {
      const selected = this.state.selectedOptions.get(fieldIndex) || new Set();
      const option = Array.from(selected)
        .map((idx) => field.options?.[idx])
        .filter((opt): opt is FormOption => opt !== undefined)[0];
      return option?.value;
    }

    return this.state.answers.get(field.key);
  }

  setAnswer(key: string, value: FieldAnswerValue): void {
    logger.debug(`[FormManager] Setting answer for field ${key}: ${JSON.stringify(value)}`);
    this.state.answers.set(key, value);
  }

  getAnswer(key: string): FieldAnswerValue | undefined {
    return this.state.answers.get(key);
  }

  hasAnswer(key: string): boolean {
    return this.state.answers.has(key);
  }

  removeAnswer(key: string): void {
    this.state.answers.delete(key);
  }

  startCustomInput(fieldIndex: number): void {
    if (!this.state.isActive || !this.state.form?.fields[fieldIndex]) {
      return;
    }

    this.state.customInputFieldIndex = fieldIndex;
  }

  clearCustomInput(): void {
    this.state.customInputFieldIndex = null;
  }

  isWaitingForCustomInput(fieldIndex: number): boolean {
    return this.state.customInputFieldIndex === fieldIndex;
  }

  addMessageId(messageId: number): void {
    this.state.messageIds.push(messageId);
  }

  setActiveMessageId(messageId: number): void {
    this.state.activeMessageId = messageId;
  }

  getActiveMessageId(): number | null {
    return this.state.activeMessageId;
  }

  getMessageIds(): number[] {
    return [...this.state.messageIds];
  }

  isActiveMessage(messageId: number | null): boolean {
    return (
      this.state.isActive &&
      this.state.activeMessageId !== null &&
      messageId === this.state.activeMessageId
    );
  }

  isActive(): boolean {
    logger.debug(
      `[FormManager] isActive check: ${this.state.isActive}, fields=${this.state.form?.fields.length ?? 0}, currentIndex=${this.state.currentFieldIndex}`,
    );
    return this.state.isActive;
  }

  cancel(): void {
    logger.info("[FormManager] Form cancelled");
    this.state.isActive = false;
    this.state.customInputFieldIndex = null;
    this.state.activeMessageId = null;
  }

  clear(): void {
    this.state = {
      form: null,
      currentFieldIndex: 0,
      answers: new Map(),
      activeMessageId: null,
      messageIds: [],
      isActive: false,
      customInputFieldIndex: null,
      selectedOptions: new Map(),
    };
  }

  getAllAnswers(): Record<string, FieldAnswerValue> {
    const result: Record<string, FieldAnswerValue> = {};

    if (!this.state.form) {
      return result;
    }

    for (const field of this.state.form.fields) {
      const answer = this.getSelectedAnswer(this.state.form.fields.indexOf(field));
      if (answer !== undefined) {
        result[field.key] = answer;
      }
    }

    return result;
  }
}

export const formManager = new FormManager();
