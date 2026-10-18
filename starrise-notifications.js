
/*
 StarRise Message Notifications
 FAM ENT
 Shared notification component
*/

(function () {
  'use strict';

  const SUPABASE_URL =
    'https://rcnikxotdalxtuvpmlvm.supabase.co';

  const SUPABASE_KEY =
    'sb_publishable_VVprrzpACjd89clo0tFs4Q_VAKVL3GN';

  let client = null;
  let currentUser = null;
  let channel = null;
  let refreshTimer = null;
  let unreadCount = 0;

  const css = `
    #starrise-notification-widget {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 9999;
      font-family: Arial, sans-serif;
    }

    .sr-notification-bell {
      position: relative;
      width: 58px;
      height: 58px;
      border-radius: 50%;
      border: 1px solid #ffffff35;
      background: #28213f;
      color: white;
      font-size: 25px;
      cursor: pointer;
      box-shadow: 0 6px 25px #0008;
    }

    .sr-notification-count {
      position: absolute;
      top: -5px;
      right: -5px;
      background: #e13c68;
      color: white;
      min-width: 23px;
      height: 23px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: bold;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 3px;
    }

    .sr-notification-panel {
      position: absolute;
      bottom: 70px;
      right: 0;
      width: min(340px, calc(100vw - 30px));
      max-height: 420px;
      overflow-y: auto;
      border-radius: 18px;
      background: #161323;
      color: white;
      border: 1px solid #ffffff30;
      box-shadow: 0 12px 40px #000a;
    }

    .sr-notification-header {
      padding: 18px;
      font-weight: bold;
      border-bottom: 1px solid #ffffff20;
    }

    .sr-notification-item {
      display: block;
      padding: 15px;
      border-bottom: 1px solid #ffffff15;
      text-decoration: none;
      color: white;
    }

    .sr-notification-item:hover {
      background: #ffffff12;
    }

    .sr-notification-name {
      font-weight: bold;
      margin-bottom: 5px;
    }

    .sr-notification-preview {
      font-size: 13px;
      color: #bbb;
    }

    .sr-notification-empty {
      padding: 20px;
      color: #aaa;
      text-align: center;
    }

    .sr-notification-hidden {
      display: none !important;
    }
  `;

  function createUI() {
    if (document.getElementById(
      'starrise-notification-widget'
    )) return;

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'starrise-notification-widget';

    root.innerHTML = `
      <button
        id="sr-notification-button"
        class="sr-notification-bell"
        type="button"
        aria-label="Open message notifications"
        aria-expanded="false"
      >
        &#128276;
        <span
          id="sr-notification-count"
          class="sr-notification-count sr-notification-hidden"
        >0</span>
      </button>

      <div
        id="sr-notification-panel"
        class="sr-notification-panel sr-notification-hidden"
      >
        <div class="sr-notification-header">
          StarRise Messages
        </div>

        <div id="sr-notification-list">
          <div class="sr-notification-empty">
            Loading...
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    const button = document.getElementById(
      'sr-notification-button'
    );

    const panel = document.getElementById(
      'sr-notification-panel'
    );

    button.addEventListener('click', () => {
      const opening = panel.classList.contains(
        'sr-notification-hidden'
      );

      panel.classList.toggle(
        'sr-notification-hidden',
        !opening
      );

      button.setAttribute(
        'aria-expanded',
        String(opening)
      );

      if (opening) refresh();
    });

    document.addEventListener('click', event => {
      if (!root.contains(event.target)) {
        panel.classList.add(
          'sr-notification-hidden'
        );
        button.setAttribute(
          'aria-expanded',
          'false'
        );
      }
    });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setCount(count) {
    unreadCount = count;

    const badge = document.getElementById(
      'sr-notification-count'
    );

    if (!badge) return;

    badge.textContent = count > 99
      ? '99+'
      : String(count);

    badge.classList.toggle(
      'sr-notification-hidden',
      count === 0
    );

    document.title = document.title.replace(
      /^\(\d+\+?\)\s*/,
      ''
    );

    if (count > 0) {
      document.title =
        '(' + count + ') ' + document.title;
    }
  }

  async function refresh() {
    if (!client || !currentUser) return;

    const list = document.getElementById(
      'sr-notification-list'
    );

    try {
      const conversationsResult = await client
        .from('member_conversations')
        .select('id,user_a,user_b')
        .or(
          'user_a.eq.' + currentUser.id +
          ',user_b.eq.' + currentUser.id
        );

      if (conversationsResult.error) {
        throw conversationsResult.error;
      }

      const conversations =
        conversationsResult.data || [];

      if (!conversations.length) {
        setCount(0);
        list.innerHTML = `
          <div class="sr-notification-empty">
            No messages yet.
          </div>
        `;
        return;
      }

      const ids = conversations.map(c => c.id);

      const messagesResult = await client
        .from('member_messages')
        .select(
          'id,conversation_id,sender_id,body,created_at'
        )
        .in('conversation_id', ids)
        .neq('sender_id', currentUser.id)
        .is('read_at', null)
        .order('created_at', { ascending: false })
        .limit(100);

      if (messagesResult.error) {
        throw messagesResult.error;
      }

      const messages = messagesResult.data || [];

      setCount(messages.length);

      if (!messages.length) {
        list.innerHTML = `
          <div class="sr-notification-empty">
            You're all caught up.
          </div>
        `;
        return;
      }

      const namesResult = await client.rpc(
        'get_conversation_member_names'
      );

      const names = new Map();

      if (!namesResult.error) {
        (namesResult.data || []).forEach(p => {
          names.set(
            String(p.member_id).toLowerCase(),
            p.messaging_name
          );
        });
      }

      const groups = new Map();

      messages.forEach(message => {
        const conversation = conversations.find(
          c => c.id === message.conversation_id
        );

        if (!conversation) return;

        const otherId =
          conversation.user_a === currentUser.id
            ? conversation.user_b
            : conversation.user_a;

        const key = conversation.id;

        if (!groups.has(key)) {
          groups.set(key, {
            conversationId: key,
            senderId: otherId,
            count: 0,
            latest: message
          });
        }

        groups.get(key).count++;
      });

      list.innerHTML = [...groups.values()]
        .map(group => {
          const name = names.get(
            String(group.senderId).toLowerCase()
          ) || 'StarRise Member';

          const preview =
            group.latest.body.length > 80
              ? group.latest.body.slice(0, 80) + '...'
              : group.latest.body;

          const destination =
            'messages.html?conversation=' +
            encodeURIComponent(group.conversationId);

          return `
            <a
              class="sr-notification-item"
              href="${destination}"
            >
              <div class="sr-notification-name">
                ${escapeHtml(name)}
                (${group.count} unread)
              </div>

              <div class="sr-notification-preview">
                ${escapeHtml(preview)}
              </div>
            </a>
          `;
        })
        .join('');

    } catch (error) {
      console.error(
        'StarRise notification error:',
        error
      );

      list.innerHTML = `
        <div class="sr-notification-empty">
          Unable to load notifications.
        </div>
      `;
    }
  }

  async function initialize() {
    if (!window.supabase) return;

    client = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_KEY,
      {
        auth: {
          persistSession: true,
          storageKey: 'sb-rcnikxotdalxtuvpmlvm-auth-token'
        }
      }
    );

    const result = await client.auth.getSession();

    currentUser = result.data.session?.user;

    if (!currentUser ||
        currentUser.is_anonymous === true) {
      return;
    }

    createUI();
    await refresh();

    channel = client
      .channel(
        'starrise-notifications-' +
        currentUser.id
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'member_messages'
        },
        () => refresh()
      )
      .subscribe();

    refreshTimer = setInterval(refresh, 30000);

    window.addEventListener('focus', refresh);

    document.addEventListener(
      'visibilitychange',
      () => {
        if (!document.hidden) refresh();
      }
    );
  }

  function start() {
    if (window.supabase) {
      initialize().catch(console.error);
      return;
    }

    const script = document.createElement('script');
    script.src =
      'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

    script.onload = () => {
      initialize().catch(console.error);
    };

    document.head.appendChild(script);
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      start,
      { once: true }
    );
  } else {
    start();
  }

})();
