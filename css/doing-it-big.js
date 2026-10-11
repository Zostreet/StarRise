
(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const client = window.supabase.createClient(
    "https://rcnikxotdalxtuvpmlvm.supabase.co",
    "sb_publishable_VVprrzpACjd89clo0tFs4Q_VAKVL3GN"
  );

  let user = null;
  let admin = false;
  let busy = false;
  let searchTimer;
  let spotlightEpoch = 0;

  const checked = result => {
    if (result.error) throw result.error;
    return result.data || [];
  };

  function el(tag, value = "", attrs = {}) {
    const node = document.createElement(tag);
    node.textContent = value;
    for (const [key, val] of Object.entries(attrs)) {
      node.setAttribute(key, val);
    }
    return node;
  }

  function status(id, message, error = false) {
    const node = $(id);
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("spotlight-error", error);
  }

  function workUrl(raw) {
    try {
      const url = new URL(raw);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !url.hostname.includes(".") ||
        ["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname)
      ) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function workLink(url) {
    const safe = workUrl(url);
    return safe
      ? el("a", "Explore Their Work ↗", {
          href: safe,
          target: "_blank",
          rel: "noopener noreferrer",
          class: "button primary"
        })
      : el("span", "Work link needs review.");
  }

  function button(label, fn) {
    const node = el("button", label, {
      type: "button",
      class: "button quiet"
    });
    node.addEventListener("click", () => void run(fn));
    return node;
  }

  async function shareSpotlight(creator, id) {
    const url = new URL("doing-it-big.html", location.href);
    url.hash = "spotlight-" + id;
    const share = {
      title: creator + " | Doing It Big | StarRise",
      text: "Discover " + creator + " on StarRise Doing It Big.",
      url: url.href
    };

    if (navigator.share) {
      try {
        await navigator.share(share);
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
    }

    try {
      await navigator.clipboard.writeText(url.href);
      status("spotlightStatus", "Spotlight link copied.");
    } catch {
      window.prompt("Copy this spotlight link:", url.href);
    }
  }

  async function run(fn) {
    if (busy) return;
    busy = true;

    const controls = [
      ...document.querySelectorAll(
        "button,#nominationForm input," +
        "#nominationForm select,#nominationForm textarea," +
        "#spotlightReview textarea"
      )
    ];
    const disabled = controls.map(node => node.disabled);
    controls.forEach(node => node.disabled = true);

    try {
      await fn();
    } catch (error) {
      status(
        admin ? "reviewStatus" : "nominationStatus",
        error.message || "Request failed. Please try again.",
        true
      );
    } finally {
      controls.forEach((node, i) => {
        node.disabled = disabled[i];
      });
      busy = false;
    }
  }

  async function loadSpotlights() {
    const request = ++spotlightEpoch;
    status("spotlightStatus", "Loading published spotlights…");

    try {
      let query = client
        .from("creator_spotlights")
        .select(
          "id,creator_name,category,work_url,city,summary,published_at"
        )
        .eq("status", "published")
        .order("published_at", { ascending: false })
        .limit(100);

      const category = $("spotlightCategory").value;
      if (category) query = query.eq("category", category);

      const data = checked(await query);
      const search = $("spotlightSearch").value
        .trim()
        .toLocaleLowerCase();

      const entries = data.filter(item =>
        `${item.creator_name} ${item.summary} ${item.city || ""}`
          .toLocaleLowerCase()
          .includes(search)
      );

      if (request !== spotlightEpoch) return;

      const root = $("spotlightCards");
      root.replaceChildren();

      for (const item of entries) {
        const card = el("article", "", {
          class: "spotlight-card",
          id: "spotlight-" + item.id
        });

        card.append(
          el("span", item.category, {
            class: "spotlight-category"
          }),
          el("h3", item.creator_name)
        );

        if (item.city) card.append(el("p", item.city));

        card.append(el("p", item.summary));

        const actions = el("div", "", {
          class: "actions"
        });
        actions.style.marginTop = "18px";

        actions.append(workLink(item.work_url));

        const share = el("button", "Share Spotlight ↗", {
          type: "button",
          class: "button quiet"
        });
        share.addEventListener("click", () => {
          void shareSpotlight(item.creator_name, item.id);
        });

        const collaborate = el("a", "Find Collaborators ↗", {
          href: "community.html",
          class: "button quiet"
        });

        actions.append(share, collaborate);
        card.append(actions);

        card.append(
          el(
            "p",
            "Featured by StarRise. Recognition does not require membership.",
            { class: "small muted" }
          )
        );

        root.append(card);
      }

      if (!entries.length) {
        const empty = el("div", "", {
          class: "spotlight-empty"
        });
        empty.append(
          el(
            "h3",
            search || category
              ? "No spotlights match your search."
              : "Who deserves their flowers?"
          ),
          el(
            "p",
            "Help us recognize talented artists and creators."
          ),
          el("a", "Nominate a Creator ↗", {
            class: "button primary",
            href: "#nominate"
          })
        );
        root.append(empty);
      }

      status(
        "spotlightStatus",
        entries.length + " published spotlights."
      );

      if (location.hash.startsWith("#spotlight-")) {
        const target = document.getElementById(
          location.hash.slice(1)
        );
        if (target) {
          target.style.borderColor = "#ecc27b";
          target.scrollIntoView({
            behavior: "smooth",
            block: "center"
          });
        }
      }
    } catch (error) {
      status(
        "spotlightStatus",
        "Spotlights couldn't load: " + error.message,
        true
      );
    }
  }

  async function loadNominations() {
    if (!user) return;

    const currentUser = user.id;
    const data = checked(
      await client
        .from("spotlight_nominations")
        .select("id,creator_name,category,status,created_at")
        .eq("nominator_id", currentUser)
        .order("created_at", { ascending: false })
        .limit(20)
    );

    if (user?.id !== currentUser) return;

    const root = $("nominationHistory");
    root.replaceChildren();

    for (const item of data) {
      const card = el("article", "", {
        class: "nomination-card"
      });

      const state =
        item.status === "selected"
          ? "Selected for recognition"
          : item.status === "declined"
          ? "Reviewed · not selected"
          : "Awaiting review";

      card.append(
        el("h3", item.creator_name),
        el("p", item.category + " · " + state),
        el(
          "small",
          new Date(item.created_at).toLocaleDateString()
        )
      );
      root.append(card);
    }

    if (!data.length) {
      root.append(
        el("p", "Your submitted nominations will appear here.")
      );
    }
  }

  async function loadReview() {
    if (!admin) return;

    status("reviewStatus", "Loading review queue…");

    const data = checked(
      await client
        .from("spotlight_nominations")
        .select(
          "id,creator_name,category,work_url,city,reason,status,created_at"
        )
        .eq("status", $("reviewFilter").value)
        .order("created_at", { ascending: false })
        .limit(100)
    );

    if (!admin) return;

    const published =
      data.length && $("reviewFilter").value === "selected"
        ? checked(
            await client
              .from("creator_spotlights")
              .select("id,summary,status")
              .in("id", data.map(item => item.id))
          )
        : [];

    if (!admin) return;

    const root = $("reviewCards");
    root.replaceChildren();

    for (const item of data) {
      const card = el("article", "", {
        class: "nomination-card"
      });

      const summary = el("textarea", "", {
        rows: 4,
        minlength: 20,
        maxlength: 2000
      });

      summary.value =
        published.find(row => row.id === item.id)?.summary ||
        item.reason;

      const label = el(
        "label",
        "Public spotlight for " + item.creator_name
      );
      label.append(summary);

      const actions = el("div", "", {
        class: "actions"
      });

      actions.append(
        button(
          item.status === "selected"
            ? "Update / republish spotlight"
            : "Publish spotlight",
          async () => {
            if (summary.value.trim().length < 20) {
              throw new Error(
                "Write at least 20 characters for the spotlight."
              );
            }

            checked(
              await client.rpc("review_creator_spotlight", {
                p_id: item.id,
                p_action: "publish",
                p_summary: summary.value.trim()
              })
            );

            await Promise.all([
              loadSpotlights(),
              loadNominations(),
              loadReview()
            ]);

            status(
              "reviewStatus",
              "Spotlight published for " + item.creator_name
            );
          }
        ),
        button("Decline nomination", async () => {
          checked(
            await client.rpc("review_creator_spotlight", {
              p_id: item.id,
              p_action: "decline"
            })
          );
          await Promise.all([
            loadNominations(),
            loadReview()
          ]);
          status("reviewStatus", "Nomination reviewed.");
        })
      );

      if (item.status === "selected") {
        actions.append(
          button("Hide spotlight", async () => {
            checked(
              await client.rpc("review_creator_spotlight", {
                p_id: item.id,
                p_action: "hide"
              })
            );
            await Promise.all([
              loadSpotlights(),
              loadReview()
            ]);
            status("reviewStatus", "Spotlight hidden.");
          })
        );
      }

      card.append(
        el("h3", item.creator_name),
        el(
          "small",
          item.category +
            (item.city ? " · " + item.city : "") +
            " · " +
            new Date(item.created_at).toLocaleDateString()
        ),
        workLink(item.work_url),
        el("p", item.reason),
        label,
        actions
      );

      root.append(card);
    }

    if (!data.length) {
      root.append(
        el("p", "No nominations in this queue yet.")
      );
    }

    status(
      "reviewStatus",
      data.length + " nominations in this queue."
    );
  }

  async function account() {
    const result = await client.auth.getUser();
    user = result.data?.user || null;

    if (user?.is_anonymous) user = null;

    admin = false;
    $("nominationSignedOut").hidden = !!user;
    $("nominationForm").hidden = !user;
    $("myNominations").hidden = !user;
    $("spotlightReview").hidden = true;

    $("nominationHistory").replaceChildren();
    $("reviewCards").replaceChildren();

    if (!user) return;

    admin = checked(
      await client
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", user.id)
    ).length > 0;

    $("spotlightReview").hidden = !admin;

    await loadNominations();
    if (admin) await loadReview();
  }

  $("nominationForm").addEventListener("submit", event => {
    event.preventDefault();

    void run(async () => {
      if (!user) {
        throw new Error("Sign in to submit a nomination.");
      }

      const url = workUrl($("nomineeWork").value);
      if (!url) {
        throw new Error("Enter a valid public HTTPS link.");
      }

      status(
        "nominationStatus",
        "Sending nomination for review…"
      );

      checked(
        await client
          .from("spotlight_nominations")
          .insert({
            creator_name: $("nomineeName").value.trim(),
            category: $("nomineeCategory").value,
            work_url: url,
            city: $("nomineeCity").value.trim(),
            reason: $("nomineeReason").value.trim()
          })
      );

      $("nominationForm").reset();

      await loadNominations();
      if (admin) await loadReview();

      status(
        "nominationStatus",
        "Nomination received. Track its review below."
      );
    });
  });

  $("refreshSpotlights").addEventListener(
    "click",
    () => void loadSpotlights()
  );

  $("spotlightCategory").addEventListener(
    "change",
    () => void loadSpotlights()
  );

  $("spotlightSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(
      () => void loadSpotlights(),
      300
    );
  });

  $("reviewFilter").addEventListener(
    "change",
    () => void run(loadReview)
  );

  client.auth.onAuthStateChange(event => {
    if (event === "SIGNED_OUT") {
      user = null;
      admin = false;

      $("nominationForm").hidden = true;
      $("nominationSignedOut").hidden = false;
      $("myNominations").hidden = true;
      $("spotlightReview").hidden = true;

      $("nominationHistory").replaceChildren();
      $("reviewCards").replaceChildren();
    }
  });

  void loadSpotlights();

  void account().catch(error => {
    status(
      "nominationStatus",
      error.message || "Account tools couldn't load.",
      true
    );
  });
})();
