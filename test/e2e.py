# End-to-end test against `wrangler dev` (local D1 + R2). Run: python3 test/e2e.py
from playwright.sync_api import sync_playwright
import json, os, urllib.request
B="http://127.0.0.1:8787"
def api(method, path, body=None):
    req=urllib.request.Request(B+"/api"+path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"X-Portal-Request":"1","Content-Type":"application/json"})
    return json.load(urllib.request.urlopen(req))
SAMPLE=[["SC-204118","Marisol Q. Vantreese","4410 Larkspur Ct","","Fullerton","CA","92831","Northgate Card Services","NG-7781-0042","2318.47","PAY-204118","2024-11-30"],
 ["SC-204133","Desmond A. Holloway","88 Cypress Bend Rd","Unit 12","Tustin","CA","92780","Brightline Auto Finance","BAF-330915","6904.10","PAY-204133","2025-01-17"],
 ["SC-204157","Priya N. Calder","1735 W Orchard Ave","","Anaheim","CA","92802","Harborview Medical Group","HMG-112-8840","845.00","PAY-204157","2025-02-28"]]
keys=["acctNo","name","addr1","addr2","city","state","zip","creditor","credAcct","balance","paymentId","chargeOff"]
api("GET","/bootstrap")
for r in SAMPLE: api("POST","/accounts",dict(zip(keys,r)))
res=[]; ok=lambda c,m: res.append(("PASS " if c else "FAIL ")+m)
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(accept_downloads=True,viewport={"width":1360,"height":900}); pg=ctx.new_page()
    errs=[]; pg.on("pageerror",lambda e:errs.append(str(e)))
    pg.on("response",lambda r: "/api/" in r.url and r.status>=400 and print("HTTP",r.status,r.request.method,r.url,r.text()[:200]))
    pg.on("console",lambda m: m.type=="error" and "fonts.g" not in m.text and "ERR_NAME_NOT_RESOLVED" not in m.text and errs.append(m.text))
    pg.goto(B); pg.wait_for_selector("tbody tr.clickable")
    T=lambda s: pg.locator(s).inner_text()
    ok(pg.locator("tbody tr.clickable").count()==3,"accounts load from D1")
    ok("you@example.com" in T(".side-user") and "admin" in T(".side-user").lower(),"signed-in user and role shown")
    pg.fill("#search","calder"); ok(pg.locator("tbody tr.clickable").count()==1,"search"); pg.fill("#search","")
    # create with validation
    pg.click("[data-act=new-account]"); pg.click("[data-act=save-account]"); ok(pg.locator("#dlg .has-err").count()>=10,"client validation")
    vals={"acctNo":"SC-300001","name":"Test Person","addr1":"1 Main","city":"Irvine","state":"CA","zip":"92618","creditor":"Acme","credAcct":"A-1","balance":"$1,234.50","paymentId":"P1","chargeOff":"03/15/2025"}
    for k,v in vals.items(): pg.fill(f"#dlg input[name={k}]",v)
    pg.click("[data-act=save-account]"); pg.wait_for_selector(".facts-strip")
    ok("$1,234.50" in T(".facts-strip"),"account saved to D1")
    pg.wait_for_selector("#history .timeline"); ok("Account created" in T("#history") and "you@example.com" in T("#history"),"history from audit log with actor")
    pg.click("[data-act=edit-account]"); pg.fill("#dlg input[name=balance]","999.99"); pg.click("[data-act=save-account]"); pg.wait_for_selector("text=Changes saved")
    pg.wait_for_selector("#history .timeline >> text=Account updated"); ok("1234.50 to 999.99" in T("#history"),"edit logged with before/after")
    # letter
    pg.click("[data-act=gen-letter]"); pg.wait_for_selector("#dlg .sheet")
    ok(pg.locator("#dlg .sheet").count()==3 and "999.99" in T("#dlg"),"Letter 1 generated server-side, 3 pages")
    ok(pg.locator('#dlg .sheet[data-mark="Unverified template"]').count()==3,"unverified mark on every page")
    with pg.expect_download(timeout=60000) as d: pg.click("#dlg [data-act=dl-one]")
    d.value.save_as("/tmp/one.pdf"); ok(d.value.suggested_filename.endswith(".pdf"),"PDF download "+d.value.suggested_filename)
    pg.keyboard.press("Escape")
    # sent dates
    pg.click(".letter-item [data-act=sent]"); pg.click("[data-act=save-sent]"); pg.wait_for_selector(".postmark:not(.pending)")
    ok(True,"sent date recorded")
    pg.click(".letter-item [data-act=sent]"); pg.fill("#dlg input[name=d]","2026-01-01"); pg.click("[data-act=save-sent]")
    ok("reason is required" in T("#dlg"),"correction needs reason")
    pg.fill("#dlg textarea[name=reason]","Typo"); pg.click("[data-act=save-sent]"); pg.click("#dlg2 [data-act=c-yes]")
    pg.wait_for_selector(".corrections"); ok("Reason: Typo" in T(".corrections"),"correction stored")
    # ledger upload/download via R2
    open("/tmp/ledger.csv","w").write("date,amt\n1,2\n")
    pg.set_input_files("#ledger-in","/tmp/ledger.csv"); pg.wait_for_selector(".files li")
    with pg.expect_download() as d: pg.click(".files a")
    d.value.save_as("/tmp/ledger-dl.csv"); ok(open("/tmp/ledger-dl.csv").read()=="date,amt\n1,2\n","ledger round-trip through R2")
    # reload persists
    pg.reload(); pg.wait_for_selector("tbody tr.clickable"); ok(pg.locator("tbody tr.clickable").count()==4,"data persists after reload")
    # import
    pg.click("[data-act=nav][data-v=import]")
    hdr="simplicity_account_number,debtor_name,address_line1,address_line2,city,state,zip,original_creditor,creditor_account_number,balance,payment_id,charge_off_date"
    pg.fill("#csv-text",hdr+"\nSC-204118,A,1 St,,X,CA,92000,C,1,10.00,P,2025-01-01\n"); pg.click("[data-act=csv-check]")
    ok(pg.locator("[data-act=csv-import]").is_disabled() and "Already exists" in T("main"),"import blocks duplicates")
    pg.fill("#csv-text",hdr+"\nSC-9001,\"Lee, Jo\",\"1 St, Ste 2\",,Irvine,ca,92618,Cred,1,\"$1,000.00\",P9,1/2/2025\nSC-9002,Kim,2 St,,Irvine,CA,92618-1234,Cred,2,5,P8,2025-01-02\n")
    pg.click("[data-act=csv-check]"); pg.click("[data-act=csv-import]"); pg.wait_for_selector("text=Imported 2 accounts")
    ok(pg.locator("tbody tr.clickable").count()==6,"import saved")
    # batch
    pg.click("[data-act=nav][data-v=batch]"); pg.check("#selall"); pg.click("[data-act=batch-gen]"); pg.wait_for_selector(".done-panel")
    ok("6 letters" in T(".done-panel"),"batch generated")
    with pg.expect_download(timeout=120000) as d: pg.click("[data-act=batch-download]")
    d.value.save_as("/tmp/batch.pdf"); ok(True,"batch PDF")
    pg.click("[data-act=batch-sent]"); pg.click("[data-act=save-bsent]"); pg.wait_for_selector("text=All letters in this batch")
    ok(True,"batch sent date")
    # templates
    pg.click("[data-act=nav][data-v=template]")
    pg.click("[data-act=tpl-verify]"); pg.click("#dlg2 [data-act=c-yes]"); pg.wait_for_selector(".verify-row.yes"); ok(True,"template verified")
    pg.click("[data-act=tpl-select][data-id=t2]"); pg.fill("#t-body","Hello {{debtor_name}}"); pg.click("[data-act=tpl-save]"); pg.wait_for_selector("text=Template saved")
    ok("placeholder" not in pg.locator("[data-act=tpl-select][data-id=t2]").inner_text(),"template edit saved")
    pg.click("[data-act=tpl-add]"); pg.wait_for_selector("text=Template added"); n=pg.locator("[data-act=tpl-select]").count()
    pg.click("[data-act=tpl-delete]"); pg.click("#dlg2 [data-act=c-yes]"); pg.wait_for_selector("text=Template removed")
    ok(pg.locator("[data-act=tpl-select]").count()==n-1,"add and remove template")
    # verified template letter has no mark
    pg.click("[data-act=nav][data-v=accounts]"); pg.click("tbody tr.clickable >> nth=0"); pg.click("[data-act=gen-letter]"); pg.wait_for_selector("#dlg .sheet")
    ok(pg.locator("#dlg .sheet[data-mark]").count()==0,"verified template prints without mark"); pg.keyboard.press("Escape")
    # admin
    pg.click("[data-act=nav][data-v=admin]"); pg.wait_for_selector("#user-form")
    pg.fill("#user-form input[name=email]","viewer@example.com"); pg.select_option("#user-form select[name=role]","viewer"); pg.click("[data-act=user-add]"); pg.wait_for_selector("td:has-text(\"viewer@example.com\")")
    ok(True,"user added")
    pg.click("[data-act=verify-chain]"); pg.wait_for_selector("text=entries check out"); ok(True,"audit chain verified")
    pg.click("[data-act=backup-now]"); pg.wait_for_selector("text=Backup saved"); ok(pg.locator("text=Passed").count()>=1,"backup to R2")
    pg.screenshot(path="/tmp/admin.png",full_page=True)
    ok(not errs,"no JS errors "+str(errs[:3]))
    b.close()
print("\n".join(res))
