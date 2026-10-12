// The settings form's fields: one value from a list, several values as checkboxes, and their labels.

import { useReducer, type ChangeEvent, type ComponentProps, type ReactNode } from "react";
import { Checkbox, Combobox, Field, FieldGroup, Row, Select, Stack, Text, TextInput } from "wings-plugin-ui";

import type { Person } from "../lib/lists";
import { render } from "../lib/page";
import { settle, setup, type ListKey, type TextKey } from "../lib/setup";
import { spinner } from "./bits";

/**
 * A text field showing a value of the form as it is now. Typing changes the form and draws only this field: the
 * lists that depend on the value load once typing stops.
 */
export function TextField({ read, onChange, ...props }: Omit<ComponentProps<typeof TextInput>, "value" | "defaultValue"> & { read: () => string | number }) {
  const [, typed] = useReducer((n: number) => n + 1, 0);
  return (
    <TextInput
      value={read()}
      onChange={(e) => {
        onChange?.(e);
        typed();
      }}
      {...props}
    />
  );
}

/** A labelled field. `id` is its input's, which the page puts focus back on after a render. */
export const labelled = (label: string, id: string, control: ReactNode, hint?: string) => (
  <Field key={label} id={id} label={label} hint={hint}>
    {control}
  </Field>
);

/** Checkboxes, and the field for more, under one label. */
export const labelledGroup = (label: string, control: ReactNode, hint?: string) => (
  <FieldGroup key={label} label={label} hint={hint}>
    {control}
  </FieldGroup>
);

/** A list state as a line under a picker. */
export const listStatus = (state: { loading: boolean; error?: string } | null, what: string) =>
  state?.loading ? (
    <Row key={what}>
      {spinner()}
      <Text size="small" tone="muted">{`Loading ${what}…`}</Text>
    </Row>
  ) : state?.error ? (
    <Text key={what} size="small" tone="danger">{`Couldn't load ${what}: ${state.error}. Type it instead.`}</Text>
  ) : null;

/**
 * One value from a list, with "Other…" for typing one, under `label`. Falls back to a text field while the list
 * loads or fails.
 */
export function pickOne(label: string, key: TextKey, options: string[] | undefined, o: { none?: string; placeholder?: string; labels?: (v: string) => string } = {}) {
  const d = setup.draft!;
  const value = String(d[key] ?? "");
  const id = `f-${key}`;
  const typed = (e: ChangeEvent<HTMLInputElement>) => {
    d[key] = e.target.value;
    setup.other[key] = d[key];
    // The lists that depend on this value load once typing stops.
    settle();
  };
  const text = <TextField key="text" id={`${id}-text`} autoComplete="off" spellCheck="false" placeholder={o.placeholder ?? undefined} read={() => String(d[key] ?? "")} onChange={typed} />;
  if (!options) return labelled(label, `${id}-text`, text);
  const isOther = key in setup.other || (value !== "" && !options.includes(value));
  // The typed value sits beside the Field, not in it: a Field gives its one control its id, and `f-…-text` is the other's.
  return (
    <Stack key={label} gap="s">
      {labelled(
        label,
        id,
        <Select
          value={isOther ? "\u0000other" : value}
          onChange={(v) => {
            if (v === "\u0000other") setup.other[key] = value;
            else {
              delete setup.other[key];
              d[key] = v;
            }
            render();
          }}
          options={[
            ...(o.none !== undefined ? [{ value: "", label: o.none }] : value === "" && !isOther ? [{ value: "", label: "Choose…", disabled: true }] : []),
            ...options.map((v) => ({ value: v, label: o.labels ? o.labels(v) : v })),
            { value: "\u0000other", label: "Other…" },
          ]}
        />,
      )}
      {isOther ? <TextField key="text" label={label} id={`${id}-text`} autoComplete="off" spellCheck="false" placeholder={o.placeholder ?? undefined} read={() => String(d[key] ?? "")} onChange={typed} /> : null}
    </Stack>
  );
}

/** The field for values a checkbox list doesn't have, and the people it finds as you type. */
function AddField({ id, read, placeholder, suggest, onType, matches, onAdd }: {
  id: string;
  read: () => string;
  placeholder: string;
  suggest: Person[] | undefined;
  onType: (text: string) => void;
  matches: () => Person[];
  onAdd: (first: Person | undefined) => void;
}) {
  // Typing draws this field and what it finds, not the page.
  const [, typed] = useReducer((n: number) => n + 1, 0);
  const found = matches();
  if (suggest) {
    return (
      <Combobox
        id={`${id}-add`}
        freeText
        open="whileText"
        openOnFocus={false}
        placeholder={placeholder}
        value={read()}
        options={found.map((p) => ({ value: p.name, label: p.name, detail: p.login }))}
        // matches() already searched what's typed.
        filter={() => true}
        empty={null}
        onInput={(text) => {
          onType(text);
          typed();
        }}
        onPick={(o) => onAdd(found.find((p) => p.name === o.value))}
        onEnter={() => onAdd(matches()[0])}
      />
    );
  }
  return (
    <TextInput
      id={`${id}-add`}
      autoComplete="off"
      spellCheck="false"
      placeholder={placeholder}
      value={read()}
      onChange={(e) => {
        onType(e.target.value);
        typed();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        onAdd(matches()[0]);
      }}
    />
  );
}

/**
 * Several values from a list as checkboxes, plus a field for values the list doesn't have. With `suggest`, the
 * field searches those people by name or email as you type.
 */
export function pickMany(key: ListKey, options: string[] | undefined, o: { labels?: (v: string) => string; extra?: string; suggest?: Person[] } = {}) {
  const d = setup.draft!;
  const values: string[] = Array.isArray(d[key]) ? d[key] : [];
  if (!(key in setup.tickedFirst) && options) setup.tickedFirst[key] = new Set(values);
  const first = setup.tickedFirst[key] ?? new Set();
  const listed = [...(options ?? [])].sort((a, b) => Number(first.has(b)) - Number(first.has(a)));
  const extras = values.filter((v) => !listed.includes(v));
  const id = `f-${key}`;
  const boxes = [...listed, ...extras].map((v, i) => (
    <Checkbox
      key={i}
      id={`${id}-${i}`}
      checked={values.includes(v)}
      onChange={(on) => {
        d[key] = on ? [...values.filter((x) => x !== v), v] : values.filter((x) => x !== v);
        render();
      }}
    >
      {o.labels ? o.labels(v) : v}
    </Checkbox>
  ));
  const addValues = (added: string[]) => {
    d[key] = [...values, ...added.filter((v) => !values.includes(v))];
    delete setup.other[key];
    setup.focusAfterRender = `${id}-add`;
    render();
  };
  const matches = () => {
    const q = (setup.other[key] ?? "").trim().toLowerCase();
    if (!q || !o.suggest) return [];
    return o.suggest.filter((p) => !values.includes(p.name) && (p.name.toLowerCase().includes(q) || p.login.toLowerCase().includes(q))).slice(0, 6);
  };
  return (
    <Stack gap="s">
      {boxes.length ? <Stack id={`${id}-list`} gap="xs" className={boxes.length > 8 ? "scroll" : undefined}>{boxes}</Stack> : null}
      <AddField
        key={key}
        id={id}
        read={() => setup.other[key] ?? ""}
        placeholder={o.extra ?? "Add another, then Enter"}
        suggest={o.suggest}
        onType={(text) => (setup.other[key] = text)}
        matches={matches}
        onAdd={(found) => addValues(found ? [found.name] : (setup.other[key] ?? "").split(",").map((v) => v.trim()).filter(Boolean))}
      />
    </Stack>
  );
}
