/**
 * Henry Keyboard Shortcuts — global hotkeys that work from any panel.
 * Registered in App.tsx on mount, cleaned up on unmount.
 */

import { useStore } from '../store';

export interface HenryShortcut {
  key: string;
  meta?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  description: string;
  action: () => void;
}

export function buildShortcuts(): HenryShortcut[] {
  const navigate = (view: string) => () => {
    useStore.getState().setCurrentView(view as any);
  };

  const injectDraft = (text: string) => () => {
    useStore.getState().setCurrentView('chat' as any);
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('henry_inject_draft', { detail: { text } })
      );
    }, 50);
  };

  return [
    // Navigation
    { key: '1', meta: true, description: 'Go to Today', action: navigate('today') },
    { key: '2', meta: true, description: 'Go to Chat', action: navigate('chat') },
    { key: '3', meta: true, description: 'Go to Tasks', action: navigate('tasks') },
    { key: '4', meta: true, description: 'Go to Journal', action: navigate('journal') },
    { key: '5', meta: true, description: 'Go to Finance', action: navigate('finance') },
    { key: '6', meta: true, description: 'Go to Calendar', action: navigate('calendar') },

    // Quick actions
    {
      key: 'k', meta: true,
      description: 'Quick ask Henry',
      action: () => {
        useStore.getState().setCurrentView('chat' as any);
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('henry_focus_input'));
        }, 50);
      },
    },
    {
      key: 'j', meta: true, shift: true,
      description: 'New journal entry',
      action: navigate('journal'),
    },
    {
      key: 'r', meta: true, shift: true,
      description: 'New reminder',
      action: navigate('reminders'),
    },
    {
      key: 'n', meta: true, shift: true,
      description: 'New capture',
      action: () => {
        window.dispatchEvent(new CustomEvent('henry_open_capture'));
      },
    },
    {
      key: 'Escape',
      description: 'Go back',
      action: () => {
        useStore.getState().goBack?.();
      },
    },
    // Mode shortcuts
    { key: 'w', meta: true, shift: true, description: 'Go to Workspace', action: navigate('workspace') },
  ];
}

export function registerShortcuts(): () => void {
  const shortcuts = buildShortcuts();

  function handler(e: KeyboardEvent) {
    // Don't fire when typing in inputs
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    ) {
      // Allow Escape even in inputs
      if (e.key !== 'Escape') return;
    }

    for (const s of shortcuts) {
      const metaMatch  = s.meta  ? (e.metaKey  || e.ctrlKey) : (!e.metaKey && !e.ctrlKey);
      const shiftMatch = s.shift ? e.shiftKey : !e.shiftKey;
      const altMatch   = s.alt   ? e.altKey   : !e.altKey;
      const keyMatch   = e.key === s.key;

      if (keyMatch && metaMatch && shiftMatch && altMatch) {
        e.preventDefault();
        s.action();
        return;
      }
    }
  }

  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
