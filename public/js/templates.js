// Letter 1 layout, reproduced from Stafford_New_1st_Notice.docx. Merge fields use {{name}}.
export const LETTER1_LAYOUT = `<div class="sheet s-cover">
  <div class="cover-addr">{{debtor_name}}<br>{{address_lines}}<br>{{city_state_zip}}</div>
</div>
<div class="sheet s-notice">
  <div class="n-top">
    <div class="n-from">
      <img class="n-logo" src="{{stafford_logo}}" alt="Stafford Group and Associates">
      P.O. Box 433<br>Orange, CA 92856<br>Toll Free: 800-820-2207<br>Monday – Friday 7:00am to 4:00pm<br><a href="http://www.staffordga.com">www.staffordga.com</a>
    </div>
    <div class="n-to">
      <div class="to-row"><span>To:</span><span>{{debtor_name}}<br><br>{{address_lines}}<br>{{city_state_zip}}</span></div>
      <div class="n-ref"><b>{{letter_date}}</b><br><b>Reference: {{reference_number}}</b></div>
    </div>
  </div>
  <p class="n-intro"><b>Stafford Group and Associates, is a debt collector.</b> We are trying to collect a debt that you owe to us. We will use any information you give us to help collect the debt.</p>
  <div class="n-cols">
    <div class="n-left">
      <h4>Our information shows:</h4>
      <p class="n-acct">You had a credit account from <b>{{original_creditor}}</b> with account number <b>{{creditor_account_number}}</b></p>
      <table class="n-tbl">
        <tr class="owed"><td>As of {{charge_off_date}}, you owed:</td><td class="op"></td><td class="cur">$</td><td class="amt"><b>{{balance_amount}}</b></td></tr>
        <tr class="sub"><td colspan="4">Between {{charge_off_date}} and today:</td></tr>
        <tr><td>You were charged this amount of interest:</td><td class="op">+</td><td class="cur">$</td><td class="amt">0.00</td></tr>
        <tr><td>You were charged this amount in fees:</td><td class="op">+</td><td class="cur">$</td><td class="amt"></td></tr>
        <tr><td>You paid or were credited this amount toward the debt:</td><td class="op">–</td><td class="cur">$</td><td class="amt">0.00</td></tr>
        <tr class="total"><td><b>Total amount of the debt now:</b></td><td class="op"></td><td class="cur"><b>$</b></td><td class="amt"><b>{{balance_amount}}</b></td></tr>
      </table>
    </div>
    <div class="n-right">
      <h4>How can you dispute the debt?</h4>
      <ul>
        <li><b>Call or write to us within 35 days from date of letter to dispute all or part of the debt.</b> If you do not, we will assume that our information is correct.</li>
        <li><b>If you write to us within 35 days from date of letter,</b> we must stop collection on any amount you dispute until we send you information that shows you owe the debt. You may use the form below or write to us without the form. You may also include supporting documents. We accept disputes electronically at <a href="http://www.staffordga.com">www.staffordga.com</a> or <a href="mailto:info@staffordga.com">info@staffordga.com</a>.</li>
      </ul>
      <h4>What else can you do?</h4>
      <ul>
        <li><b>Write to ask for the name and address of the original creditor, if different from the current creditor.</b> If you write within 35 days from date of letter, we must stop collection until we send you that information. You may use the form below or write to us without the form. We accept such requests electronically at <a href="http://www.staffordga.com">www.staffordga.com</a> or <a href="mailto:info@staffordga.com">info@staffordga.com</a>.</li>
        <li><b>Go to <a href="http://www.cfpb.gov/debt-collection">www.cfpb.gov/debt-collection</a> to learn more about your rights under federal law.</b> For instance, you have the right to stop or limit how we contact you.</li>
        <li>Contact us about your payment options.</li>
        <li>Póngasse en contacto con nosotros para solicitor una copia de este formulario en español.</li>
      </ul>
    </div>
  </div>
  <div class="cut" aria-hidden="true"><span>✂</span></div>
  <div class="n-form">
    <div class="n-mail">
      <b class="mail-h">Mail this form to:</b>
      <p>Stafford Group and Associates<br>P.O. Box 433<br>Orange, CA 92856</p>
      <p class="n-debtor">{{debtor_name}}<br>{{address_lines}}<br>{{city_state_zip}}</p>
      <p class="n-pay"><b>PAY ONLINE:</b> <a href="http://www.staffordga.com">www.staffordga.com</a><br>Enter your 16 digit Payment ID: <b>{{payment_id}}</b></p>
      <p class="n-lic"><b>CA License# 10757-99</b></p>
    </div>
    <div class="n-respond">
      <h4>How do you want to respond?</h4>
      <p class="chk-h">Check all that apply:</p>
      <ul class="chk">
        <li><b>I want to dispute the debt because I think:</b>
          <ul class="chk"><li>This is not my debt.</li><li>The amount is wrong.</li><li>Other (please describe on reverse or attach additional information).</li></ul></li>
        <li><b>I want you to send me the name and address of the original creditor.</b></li>
        <li><b>I enclosed this amount</b> <span class="blank">$</span>
          <div class="chk-note">Make your check payable to {{company_name}}. Include the reference number {{reference_number}}</div></li>
        <li><b>Quiero este formulario en español.</b></li>
      </ul>
    </div>
  </div>
</div>
<div class="sheet s-disc">
  <h3>DISCLOSURES NOTICE</h3>
  <p>California FDBPA: Pursuant to the California State Fair Debt Buying Practices Act, you may request records at any time showing the following: (1) that Stafford Group and Associates has the right to seek collection of the debt; (2) the debt balance, including an explanation of any interest charges and additional fees; (3) the date of default or the date of the last payment; (4) the name of the charge-off creditor and the account number associated with the debt; (5) the name and last known address of the debtor as it appeared in the charge-off creditors or debt buyers records prior to the sale of the debt, as appropriate; and (6) the names of all persons or entities that have purchased the debt. You may also request from us a copy of the contract or other document evidencing your agreement to the debt. A request for these records may be addressed to: Stafford Group and Associates located at P.O. Box 433, Orange, CA 92856.</p>
  <p>Credit Reporting: As required by law, you are hereby notified that a negative credit report reflecting on your credit record may be submitted to a credit reporting agency if you fail to fulfill the terms of your credit obligations. But we will not submit a negative credit report to a credit reporting agency about this credit obligation until the expiration of the time period.</p>
  <p>California Residents: The state Rosenthal Fair Debt Collection Practices Act and the federal Fair Debt Collection Practices Act require that, except under unusual circumstances, collectors may not contact you before 8 a.m. or after 9 p.m. They may not harass you by using threats of violence or arrest or by using obscene language. Collectors may not use false or misleading statements or call you at work if they know or have reason to know that you may not receive personal calls at work. For the most part, collectors may not tell another person, other than your attorney or spouse, about your debt. Collectors may contact another person to confirm your location or enforce a judgment. For more information about debt collection activities, you may contact the Federal Trade Commission at 1-877-FTC-HELP or <a href="http://www.ftc.gov">www.ftc.gov</a>.</p>
</div>`;
