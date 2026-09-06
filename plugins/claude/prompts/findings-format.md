Format the full review as compact Markdown using this layout:

# Claude Review

Target: <review scope and base reference, if any> Verdict:
<approve or needs-attention>

<One short summary paragraph.>

Findings:

- [high] Short actionable title (path/to/file:42) Concrete failure scenario,
  cause, and impact in one concise paragraph. Recommendation: A specific fix.

Use "Claude Adversarial Review" as the heading for adversarial reviews. For a
stop-gate review, put the required ALLOW or BLOCK decision on the first line,
then a blank line followed by this full review layout. The decision and verdict
must agree.

Use critical, high, medium, and low severity labels, ordered most severe first.
These correspond to P0, P1, P2, and P3 respectively; display only the severity
word, not both labels. Use a short line range when necessary (file:42-45). Each
finding has one title line, one explanation paragraph, and one Recommendation
line. Do not add separate severity, location, scenario, or contract-broken
bullets. Separate findings with a blank line.

If there are no actionable findings, replace the Findings section with "No
material findings." Add a short Next steps list only when useful. Put material
review limitations in one short final paragraph. Keep unsupported design
questions out of the findings list.
