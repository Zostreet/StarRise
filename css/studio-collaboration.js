(() => {
  "use strict";
  const $=id=>document.getElementById(id),bridge=()=>window.StarRiseStudioBridge;
  const uuid=value=>/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value||"");
  const URL_API="https://rcnikxotdalxtuvpmlvm.supabase.co",URL_STORAGE="https://rcnikxotdalxtuvpmlvm.storage.supabase.co",KEY="sb_publishable_VVprrzpACjd89clo0tFs4Q_VAKVL3GN";
  let client=null,user=null,selected="",sessions=[],members=[],team=[],versions=[],comments=[],busy=false,selectionEpoch=0;
  let activeUpload=null,cancelUpload=null,clientPromise=null;
  const status=text=>{$("collaborationStatus").textContent=text;};
  function el(tag,text="",attrs={}){const node=document.createElement(tag);node.textContent=text;for(const[key,value]of Object.entries(attrs))node.setAttribute(key,value);return node;}
  function button(text,handler,attrs={}){const node=el("button",text,{type:"button",class:"button quiet",...attrs});node.addEventListener("click",()=>void run(handler));return node;}
  function field(text,tag="input",attrs={}){const control=el(tag,"",attrs),label=el("label",text);label.append(control);return{label,control};}
  const name=id=>members.find(m=>m.id===id)?.display_name||(id===user?.id?"You":`Member ${String(id).slice(0,8)}`);
  const date=value=>new Date(value).toLocaleString();
  const checked=result=>{if(result.error)throw result.error;return result.data;};
  const rpc=async(name,args)=>checked(await client.rpc(name,args));
  function setBusy(value){busy=value;document.querySelectorAll("#collaborationDialog button,#collaborationDialog input,#collaborationDialog select,#collaborationDialog textarea").forEach(node=>node.disabled=value);}
  async function run(handler){if(busy)return;setBusy(true);try{await handler();}catch(error){status(error.message||"The studio connection failed. Your local project is kept.");}finally{setBusy(false);}}
  function script(src){return new Promise((resolve,reject)=>{const node=document.createElement("script");node.src=src;node.onload=resolve;node.onerror=()=>{node.remove();reject(new Error("The collaboration client couldn't load. Reload and try again."));};document.head.append(node);});}
  async function getClient(){
    if(client)return client;
    if(!clientPromise)clientPromise=(async()=>{
      await script("css/studio-supabase-2.117.3.js");await script("css/studio-tus-4.3.1.js");client=window.supabase.createClient(URL_API,KEY);
      client.auth.onAuthStateChange(event=>{if(event==="SIGNED_OUT"){user=null;$("cloudSignedIn").hidden=true;$("cloudSignedOut").hidden=false;status("Signed out. Your browser project is kept.");}});
      return client;
    })().catch(error=>{clientPromise=null;throw error;});
    return clientPromise;
  }
  async function account(){
    await getClient();const result=await client.auth.getUser();user=result.data?.user||null;if(user?.is_anonymous)user=null;
    $("cloudSignedOut").hidden=!!user;$("cloudSignedIn").hidden=!user;
    $("collaborationLogin").href=`login.html?redirect=${encodeURIComponent("creator-studio.html?room=audio"+(selected?`&session=${selected}`:""))}`;
    if(!user){status("Sign in to invite members and publish private versions. Local creation and studio exports work without signing in.");return false;}
    status("Loading your private sessions…");members=checked(await client.rpc("get_public_members"))||[];return true;
  }
  function renderSessionList(){
    const list=$("sharedSessionList");list.replaceChildren();if(!sessions.length)list.append(el("p","No shared sessions yet. Share your current project to start."));
    for(const session of sessions){const own=session.owner_id===user.id,invite=team.find(c=>c.session_id===session.id&&c.user_id===user.id);const label=`${session.name} · ${own?"Owner":invite?.status==="invited"?"Invitation":invite?.role||"Collaborator"}`;list.append(button(label,()=>select(session.id),{class:"shared-session",...(session.id===selected?{"aria-current":"true"}:{})}));}
  }
  async function refresh(){
    if(!user)return;
    [sessions,team]=await Promise.all([
      client.from("studio_sessions").select("id,owner_id,name,description,created_at").eq("archived",false).order("created_at",{ascending:false}).limit(100).then(checked),
      client.from("studio_collaborators").select("session_id,user_id,role,status,invited_by").limit(1000).then(checked)
    ]);sessions=sessions||[];team=team||[];
    if(selected&&!sessions.some(s=>s.id===selected)){const linked=checked(await client.from("studio_sessions").select("id,owner_id,name,description,created_at").eq("id",selected).maybeSingle());if(linked)sessions.unshift(linked);}
    renderSessionList();
    if(selected&&sessions.some(s=>s.id===selected))await select(selected);
    else{selected="";$("sharedSessionDetail").replaceChildren(el("p","Choose a session or share the project you're working on."));status("Private sessions are up to date.");}
  }
  async function select(id){
    const epoch=++selectionEpoch;selected=id;const session=sessions.find(s=>s.id===id);if(!session)return;renderSessionList();
    const owner=session.owner_id===user.id,invitation=team.find(c=>c.session_id===id&&c.user_id===user.id),detail=$("sharedSessionDetail");detail.replaceChildren(el("h3",session.name),el("p",session.description||"Private artist / creator session."));
    if(!owner&&invitation?.status==="invited"){
      detail.append(el("p",`${name(session.owner_id)} invited you as an ${invitation.role}. Accept to access this session's projects, recordings, and comments.`),
        button("Accept invitation",async()=>{await rpc("studio_respond_invite",{p_session:id,p_accept:true});await refresh();status("Invitation accepted. You can open published versions.");}),
        button("Decline invitation",async()=>{await rpc("studio_respond_invite",{p_session:id,p_accept:false});selected="";await refresh();status("Invitation declined.");}));return;
    }
    if(!owner&&invitation?.status!=="accepted"){detail.append(el("p","Access to this session is unavailable."));return;}
    const results=await Promise.all([
      client.from("studio_versions").select("id,session_id,author_id,base_version_id,label,notes,asset_path,asset_bytes,state,created_at").eq("session_id",id).eq("state","ready").order("created_at",{ascending:false}).limit(100).then(checked),
      client.from("studio_comments").select("id,version_id,author_id,body,created_at").eq("session_id",id).order("created_at",{ascending:false}).limit(100).then(checked),
      client.from("studio_collaborators").select("session_id,user_id,role,status,invited_by").eq("session_id",id).then(checked)
    ]);if(epoch!==selectionEpoch)return;[versions,comments]=results;const collaborators=results[2]||[];
    const link=el("input","",{readonly:"","aria-label":"Private session link"});link.value=`${location.origin}${location.pathname}?room=audio&session=${id}#workspace`;
    detail.append(el("p",`Owner: ${name(session.owner_id)} · ${owner?"You manage invitations":invitation.role==="editor"?"You can publish versions and comment":"You can open versions and comment"}`),el("label","Private session link"),link,
      button("Copy session link",async()=>{try{await navigator.clipboard.writeText(link.value);status("Session link copied. Only invited members can access it.");}catch{link.focus();link.select();status("Select and copy the session link. It does not grant access on its own.");}}));
    if(owner){
      const section=el("section","",{class:"cloud-section"});section.append(el("h4","Invite an artist or creator"));
      const search=field("Find a registered member","input",{type:"search",placeholder:"Search display names"}),recipient=field("Member","select"),role=field("Role","select");
      role.control.append(el("option","Editor · Open, comment, publish",{value:"editor"}),el("option","Viewer · Open and comment",{value:"viewer"}));
      const choices=()=>{const term=search.control.value.toLowerCase().trim();recipient.control.replaceChildren(el("option","Choose a member…",{value:""}));for(const m of members.filter(m=>m.id!==user.id&&String(m.display_name).toLowerCase().includes(term)).slice(0,100))recipient.control.append(el("option",`${m.display_name} · ${m.role||"Member"} · ${m.id.slice(0,6)}`,{value:m.id}));};search.control.addEventListener("input",choices);choices();
      section.append(search.label,recipient.label,role.label,button("Send private invitation",async()=>{
        if(!uuid(recipient.control.value))throw new Error("Choose a registered member to invite.");await rpc("studio_invite_member",{p_session:id,p_user:recipient.control.value,p_role:role.control.value});await refresh();status("Private invitation added. Send the session link to your collaborator; no email is sent automatically.");
      }));
      const roster=el("div","",{class:"collaborator-list"});
      for(const c of collaborators.filter(c=>c.status==="accepted"||c.status==="invited")){const row=el("div","",{class:"collaborator-row"});row.append(el("span",`${name(c.user_id)} · ${c.role} · ${c.status}`),button("Remove access",async()=>{if(!await bridge().ask("Remove this collaborator?",`${name(c.user_id)} will lose access to future downloads and publishing. Copies already downloaded remain with them.`,"Remove access"))return;await rpc("studio_remove_member",{p_session:id,p_user:c.user_id});await refresh();status("Collaborator access removed.");},{"aria-label":`Remove access for ${name(c.user_id)}`}));roster.append(row);}section.append(roster);detail.append(section);
    }
    if(owner||invitation.role==="editor"){
      const section=el("section","",{class:"cloud-section"});section.append(el("h4","Publish your current project"));
      const label=field("Version name","input",{maxlength:"160",placeholder:"Vocal edit, beat v2, engineer mix…"});label.control.value=`${bridge().projectInfo().name.slice(0,125)} · ${new Date().toLocaleDateString()}`;
      const notes=field("What changed / feedback requested","textarea",{rows:"3",maxlength:"5000"});section.append(label.label,notes.label,el("p","Publishing uploads the whole current project, including recordings and drafts, to this private team. Other members open an independent local copy. Versions do not merge automatically.",{class:"small muted"}),button("Publish project version",()=>publish(id,label.control.value,notes.control.value)));detail.append(section);
    }
    const history=el("section","",{class:"cloud-section"});history.append(el("h4","Session versions"));if(!versions.length)history.append(el("p","No versions published yet."));
    for(const v of versions){const card=el("article","",{class:"version-card"});card.append(el("strong",v.label),el("p",`${name(v.author_id)} · ${date(v.created_at)} · ${(v.asset_bytes/1048576).toFixed(1)} MB${v.base_version_id?" · built from an earlier version":""}`,{class:"small muted"}),el("p",v.notes),button("Open editable copy",async()=>{
      if(!await bridge().ask("Open this shared version?",`Your current local project will be saved. ${v.label} opens as a separate project.`,"Open version"))return;status("Downloading the private version…");const blob=checked(await client.storage.from("studio-sessions").download(v.asset_path));if(blob.size!==v.asset_bytes||blob.size>52428800)throw new Error("The downloaded project size doesn't match its published version.");await bridge().importBackup(await blob.text(),{sessionId:id,versionId:v.id});$("collaborationDialog").close();bridge().showNote("Shared version opened. Edit it, then Collaborate → Publish project version to send your changes.");
    },{"aria-label":`Open editable copy of ${v.label}`}));history.append(card);}detail.append(history);
    const discussion=el("section","",{class:"cloud-section"});discussion.append(el("h4","Team notes & feedback"));const versionField=field("Comment on","select");versionField.control.append(el("option","Whole session",{value:""}),...versions.map(v=>el("option",v.label,{value:v.id})));
    const body=field("Your comment","textarea",{rows:"3",maxlength:"2000",placeholder:"Timing notes, lyric changes, arrangement ideas, studio instructions…"});discussion.append(versionField.label,body.label,button("Post team comment",async()=>{if(!body.control.value.trim())throw new Error("Write a comment first.");await rpc("studio_add_comment",{p_session:id,p_body:body.control.value,p_version:versionField.control.value||null});await select(id);status("Comment posted to this private session.");}));
    for(const c of comments){const card=el("article","",{class:"comment-card"});card.append(el("strong",name(c.author_id)),el("p",`${date(c.created_at)}${c.version_id?" · "+(versions.find(v=>v.id===c.version_id)?.label||"Earlier version"):""}`,{class:"small muted"}),el("p",c.body));discussion.append(card);}detail.append(discussion);status(`${versions.length} published ${versions.length===1?"version":"versions"} · Private session ready.`);
  }
  async function upload(blob,path){
    await new Promise((resolve,reject)=>{
      cancelUpload=()=>{void activeUpload?.abort(false);reject(new Error("Upload canceled. Your local project is kept."));};
      activeUpload=new window.tus.Upload(blob,{endpoint:`${URL_STORAGE}/storage/v1/upload/resumable`,chunkSize:6*1024*1024,retryDelays:[0,3000,5000,10000,20000],uploadDataDuringCreation:true,removeFingerprintOnSuccess:true,storeFingerprintForResuming:false,headers:{apikey:KEY,"x-upsert":"false"},metadata:{bucketName:"studio-sessions",objectName:path,contentType:"application/json",cacheControl:"3600"},
        onBeforeRequest:async req=>{const session=checked(await client.auth.getSession());if(!session?.session?.access_token)throw new Error("Your account session expired. Sign in and publish again.");req.setHeader("Authorization",`Bearer ${session.session.access_token}`);},
        onProgress:(sent,total)=>status(`Publishing private project… ${Math.round(sent/total*100)}%`),onError:reject,onSuccess:resolve});activeUpload.start();
    });activeUpload=null;cancelUpload=null;
  }
  async function publish(id,label,notes){
    if(!label.trim())throw new Error("Give this version a name.");const verified=checked(await client.auth.getUser());if(!verified?.user||verified.user.id!==user.id)throw new Error("Sign in again before publishing.");
    status("Saving your local project and preparing this version…");const blob=await bridge().backupBlob();if(blob.size>52428800)throw new Error("This project backup is larger than the 50 MB shared-version limit. Export a studio ZIP and send the larger files separately, or use a smaller local copy.");
    const info=bridge().projectInfo(),base=info.collaboration.sessionId===id?info.collaboration.baseVersionId||null:null;
    const reservation=(await rpc("studio_reserve_version",{p_session:id,p_label:label.trim(),p_notes:notes,p_bytes:blob.size,p_base_version:base}))[0];
    const cancel=el("button","Cancel upload",{type:"button",class:"button quiet",id:"cancelCloudUpload"});cancel.addEventListener("click",()=>cancelUpload?.());$("collaborationStatus").after(cancel);
    try{await upload(blob,reservation.asset_path);status("Finalizing this private version…");await rpc("studio_finish_version",{p_version:reservation.version_id});await bridge().setCollaboration(id,reservation.version_id);await refresh();status("Project version published. Invited members can open and build on this version.");}
    catch(error){await rpc("studio_cancel_version",{p_version:reservation.version_id}).catch(()=>{});throw error;}
    finally{activeUpload=null;cancelUpload=null;cancel.remove();}
  }
  $("createSharedSession").addEventListener("click",()=>void run(async()=>{if(!user)return;const info=bridge().projectInfo();selected=await rpc("studio_create_session",{p_name:info.name,p_description:""});await refresh();status("Private session created. Publish your first project version, then invite your collaborators.");}));
  $("refreshSharedSessions").addEventListener("click",()=>void run(refresh));$("closeCollaboration").addEventListener("click",()=>{if(!busy)$("collaborationDialog").close();});$("collaborationDialog").addEventListener("cancel",event=>{if(busy)event.preventDefault();});
  async function open(){await bridge().ready;await bridge().pause();const linked=new URLSearchParams(location.search).get("session"),info=bridge().projectInfo();selected=uuid(linked)?linked:info.collaboration.sessionId||selected;$("collaborationDialog").showModal();await run(async()=>{if(await account())await refresh();});}
  $("openCollaboration").addEventListener("click",()=>void open().catch(error=>bridge()?.showNote(error.message)));const linked=new URLSearchParams(location.search).get("session");if(uuid(linked))void open().catch(error=>bridge()?.showNote(error.message));
})();
