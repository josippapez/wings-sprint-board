// The Sprint board's own boxes: HTML tags in the browser, styled by sidebar.css, and wings-plugin-ui's in the native
// app, which draws no HTML.
import { createElement, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import * as native from "./layout-native";

function wrapper(tag: "div" | "span" | "p" | "ul" | "li") {
  return function Layout(props: HTMLAttributes<HTMLElement>) {
    return WINGS_NATIVE ? <native.Layout tag={tag} {...props} /> : createElement(tag, props);
  };
}

export const Box = wrapper("div");
export const Inline = wrapper("span");
export const Para = wrapper("p");
export const Unordered = wrapper("ul");
export const Item = wrapper("li");

/** A plain button of the page's own look: its click handler gets no event. */
export type PlainButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & { onClick?: () => void; children?: ReactNode };

export function PlainButton(props: PlainButtonProps) {
  return WINGS_NATIVE ? <native.PlainButton {...props} /> : createElement("button", props);
}
