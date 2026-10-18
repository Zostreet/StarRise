
/*
 * StarRise Message Notifications
 * FAM ENT
 * Visible bell, session handling, unread messages
 */
(function () {
  'use strict';

  if (window.__starRiseNotificationsLoaded) return;
  window.__starRiseNotificationsLoaded = true;

  const SUPABASE_URL =
    'https://rcnikxotdalxtuvpmlvm.supabase.co';

  const SUPABASE_KEY =
    'sb_publishable_VVprrzpACjd89clo0tFs4Q_VAKVL3GN';

  let client = null;
  let currentUser = null;
  let channel = null;
  let timer = null;
  let loading = false;

  const $ = id => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createUI() {
    if ($('starrise-notification-widget')) return;

    const style = document.createElement('style');

    style.textContent = `
      #starrise-notification-widget {
        position: fixed !important;
        right: 16px !important;
        bottom: 90px !important;
        z-index: 2147483647 !important;
        font-family: Arial, sans-serif;
      }

      #sr-notification-button {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 58px;
        height: 58px;
        border: 2px solid #f4b942;
        border-radius: 50%;
        background: #21162f;
        color: #fff;
        font-size: 27px;
        cursor: pointer;
        box-shadow: 0 5px 24px #0009;
      }

      #sr-notification-count {
        position: absolute;
        top: -7px;
        right: -7px;
        min-width: 23px;
        height: 23px;
        padding: 3px;
        border-radius: 20px;
        background: #e53e70;
        color: white;
        font-size: 12px;
        font-weight: bold;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #sr-notification-panel {
        position: absolute;
        bottom: 70px;
        right: 0;
        width: min(340px, calc(100vw - 32px));
        max-height: min(430px, 65vh);
        overflow-y: auto;
        border: 1px solid #ffffff40;
        border-radius: 16px;
        background: #171324;
        color: white;
        box-shadow: 0 12px 40px #000b;
      }

      .sr-notification-header {
        padding: 16px;
        font-weight: bold;
        border-bottom: 1px solid #ffffff25;
      }

      .sr-notification-item {
        display: block;
        padding: 15px;
        color: white;
        text-decoration: none;
        border-bottom: 1px solid #ffffff20;
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
        line-height: 1.5;
        color: #ccc;
      }

      .sr-notification-empty {
        padding: 20px;
        color: #ddd;
        line-height: 1.6;
      }

      .sr-notification-hidden {
        display: none !important;
      }
    `;

    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'starrise-notification-widget';

    root.innerHTML = `
      <button
        id="sr-notification-button"
        type="button"
        aria-label="Message notifications"
        aria-expanded="false"
      >
        &#128276;
        <span
          id="sr-notification-count"
          class="sr-notification-hidden"
        >0</span>
      </button>

      <div
        id="sr-notification-panel"
        class="sr-notification-hidden"
        role="region"
        aria-label="StarRise notifications"
      >
        <div class="sr-notification-header">
          StarRise Messages
        </div>
        <div id="sr-notification-list">
          <div class="sr-notification-empty">
            Connecting...
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    const button = $('sr-notification-button');
    const panel = $('sr-notification-panel');

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

      if (opening) {
        if (currentUser) {
          refresh();
        } else {
          showMessage(
            'Checking your StarRise sign-in...'
          );
          checkSession();
        }
      }
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

  function showMessage(message) {
    const list = $('sr-notification-list');

    if (list) {
      list.innerHTML =
        '<div class="sr-notification-empty">' +
        escapeHtml(message) +
        '</div>';
    }
  }

  function setCount(count) {
    const badge = $('sr-notification-count');
    if (!badge) return;

    badge.textContent =
      count > 99 ? '99+' : String(count);

    badge.classList.toggle(
      'sr-notification-hidden',
      count === 0
    );
  }

  async function refresh() {
    if (!client || !currentUser || loading) return;

    loading = true;

    try {
      const { data: conversations, error: conversationError } =
        await client
          .from('member_conversations')
          .select('id,user_a,user_b')
          .or(
            'user_a.eq.' + currentUser.id +
            ',user_b.eq.' + currentUser.id
          );

      if (conversationError) throw conversationError;

      const rows = conversations || [];

      if (!rows.length) {
        setCount(0);
        showMessage('No conversations yet.');
        return;
      }

      const ids = rows.map(row => row.id);

      const { data: messages, error: messageError } =
        await client
          .from('member_messages')
          .select(
            'id,conversation_id,sender_id,body,created_at'
          )
          .in('conversation_id', ids)
          .neq('sender_id', currentUser.id)
          .is('read_at', null)
          .order('created_at', { ascending: false })
          .limit(100);

      if (messageError) throw messageError;

      const unread = messages || [];
      setCount(unread.length);

      if (!unread.length) {
        showMessage("You're all caught up.");
        return;
      }

      const names = new Map();

      const { data: nameRows, error: nameError } =
        await client.rpc(
          'get_conversation_member_names'
        );

      if (!nameError) {
        (nameRows || []).forEach(row => {
          names.set(
            String(row.member_id).toLowerCase(),
            row.messaging_name || 'StarRise Member'
          );
        });
      }

      const grouped = new Map();

      unread.forEach(message => {
        const conversation = rows.find(
          row => row.id === message.conversation_id
        );

        if (!conversation) return;

        const otherId =
          conversation.user_a === currentUser.id
            ? conversation.user_b
            : conversation.user_a;

        if (!grouped.has(conversation.id)) {
          grouped.set(conversation.id, {
            id: conversation.id,
            senderId: otherId,
            count: 0,
            latest: message
          });
        }

        grouped.get(conversation.id).count++;
      });

      $('sr-notification-list').innerHTML =
        [...grouped.values()].map(group => {
          const name =
            names.get(
              String(group.senderId).toLowerCase()
            ) || 'StarRise Member';

          const body = String(
            group.latest.body || ''
          );

          const preview =
            body.length > 80
              ? body.slice(0, 80) + '...'
              : body;

          return `
            <a
              class="sr-notification-item"
              href="messages.html?conversation=${encodeURIComponent(group.id)}"
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
        }).join('');

    } catch (error) {
      console.error(
        'StarRise notification refresh:',
        error
      );

      showMessage(
        'Notifications could not load: ' +
        (error.message || 'Connection error')
      );
    } finally {
      loading = false;
    }
  }

  function subscribe() {
    if (!client || !currentUser) return;

    if (channel) {
      client.removeChannel(channel);
    }

    channel = client
      .channel(
        'starrise-notifications-' + currentUser.id
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
  }

  async function checkSession() {
    if (!client) {
      showMessage('Connecting to StarRise...');
      return;
    }

    try {
      const { data, error } =
        await client.auth.getSession();

      if (error) throw error;

      const user = data.session?.user;

      if (!user || user.is_anonymous === true) {
        currentUser = null;
        setCount(0);

        showMessage(
          'Please sign in to StarRise to view your message notifications.'
        );
        return;
      }

      const changed =
        !currentUser ||
        currentUser.id !== user.id;

      currentUser = user;

      if (changed) subscribe();

      await refresh();

    } catch (error) {
      console.error(
        'StarRise notification session:',
        error
      );

      showMessage(
        'Could not verify sign-in: ' +
        (error.message || 'Connection error')
      );
    }
  }

  function initialize() {
    createUI();

    if (!window.supabase) {
      showMessage(
        'Supabase is loading. Please wait.'
      );

      const script = document.createElement('script');
      script.src =
        'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

      script.onload = connect;
      script.onerror = () => {
        showMessage(
          'Unable to load StarRise messaging connection.'
        );
      };

      document.head.appendChild(script);
      return;
    }

    connect();
  }

  function connect() {
    try {
      client = window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_KEY
      );

      checkSession();

      timer = setInterval(
        checkSession,
        30000
      );

      window.addEventListener(
        'focus',
        checkSession
      );

      document.addEventListener(
        'visibilitychange',
        () => {
          if (!document.hidden) checkSession();
        }
      );

    } catch (error) {
      console.error(
        'StarRise notification initialization:',
        error
      );

      showMessage(
        'Unable to connect notifications: ' +
        (error.message || 'Unknown error')
      );
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      initialize,
      { once: true }
    );
  } else {
    initialize();
  }

})();
