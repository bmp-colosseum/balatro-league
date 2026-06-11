"use client";

// Drop-in replacement for a native <select name> inside a server-action form.
// Renders the shadcn (Base UI) Select — styled trigger + themed popup menu —
// while mirroring the chosen value into a hidden <input name>, so the server
// action reads the exact same FormData key as the old native select did.
//
// Two gotchas this hides so callers don't have to think about them:
//   1. Base UI Select items can't use an empty-string value, so an
//      empty option ("— none —", "All") is encoded to a sentinel internally
//      and decoded back to "" in the submitted hidden input.
//   2. A "" value with no matching empty option falls through to the
//      placeholder (the disabled "— pick one —" prompt pattern).
//
// Note: a hidden input isn't constraint-validated, so `required` here is
// advisory — the backing server action is the real gate (all of them already
// validate their inputs). Kept as a prop for intent/parity with the old markup.

import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface FormSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

const EMPTY = "__empty__";
const enc = (v: string) => (v === "" ? EMPTY : v);
const dec = (v: string | null) => (v === EMPTY || v == null ? "" : v);

export function FormSelect({
  name,
  options,
  defaultValue = "",
  placeholder,
  required,
  title,
  triggerClassName,
  size,
}: {
  name: string;
  options: FormSelectOption[];
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  title?: string;
  triggerClassName?: string;
  size?: "sm" | "default";
}) {
  const [value, setValue] = useState(defaultValue);
  const hasEmptyOption = options.some((o) => o.value === "");
  // "" → show the empty option if there is one, else fall through to placeholder.
  const rootValue = value === "" ? (hasEmptyOption ? EMPTY : "") : value;
  // Base UI resolves the trigger's displayed label from `items`, not from the
  // raw value — without this the trigger shows the value ("name") or even the
  // "__empty__" sentinel instead of the option's label.
  const items = options.map((o) => ({ value: enc(o.value), label: o.label }));

  return (
    <>
      <input type="hidden" name={name} value={value} required={required} />
      <Select items={items} value={rootValue} onValueChange={(v) => setValue(dec(v))}>
        <SelectTrigger className={triggerClassName} title={title} size={size}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={enc(o.value)} value={enc(o.value)} disabled={o.disabled}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
