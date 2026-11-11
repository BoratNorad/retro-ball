import type { GameResult } from "@tdf/sim";

export function BoxScore({ r }: { r: GameResult }) {
  const [a, b] = r.names;
  const [ta, tb] = r.teams;
  const q = Math.max(ta.byQuarter.length, tb.byQuarter.length, 4);
  const rows: [string, (t: typeof ta) => string][] = [
    ["First downs", (t) => `${t.firstDowns}`],
    ["Total yards", (t) => `${t.totalYds}`],
    ["Passing", (t) => `${t.passComp}/${t.passAtt} ${t.passYds - t.sackYds}`],
    ["Rushing", (t) => `${t.rushAtt}-${t.rushYds}`],
    ["Turnovers", (t) => `${t.turnovers}`],
    ["Sacked", (t) => `${t.sacksTaken}`],
    ["3rd down", (t) => `${t.thirdConv}/${t.thirdAtt}`],
    ["Penalties", (t) => `${t.penalties}-${t.penaltyYds}`],
  ];
  const top = (k: string, n: number) => r.players.filter((p) => ((p[k] as number) ?? 0) > 0).sort((x, y) => ((y[k] as number) ?? 0) - ((x[k] as number) ?? 0)).slice(0, n);
  return (
    <div class="box">
      <div class="title">FINAL</div>
      <table>
        <thead><tr><th></th>{Array.from({ length: q }, (_, i) => <th>{i < 4 ? `Q${i + 1}` : "OT"}</th>)}<th>F</th></tr></thead>
        <tbody>
          {[ta, tb].map((t, i) => <tr><td>{i ? b : a}</td>{Array.from({ length: q }, (_, j) => <td>{t.byQuarter[j] ?? 0}</td>)}<td><b>{t.score}</b></td></tr>)}
        </tbody>
      </table>
      <table>
        <thead><tr><th></th><th>{a}</th><th>{b}</th></tr></thead>
        <tbody>{rows.map(([l, f]) => <tr><td>{l}</td><td>{f(ta)}</td><td>{f(tb)}</td></tr>)}</tbody>
      </table>
      <div class="leaders">
        {top("passYds", 2).map((p) => <div>{r.names[p.team]} {p.name}: {p.passComp ?? 0}/{p.passAtt} {p.passYds} yds {p.passTd ?? 0} TD</div>)}
        {top("rushYds", 2).map((p) => <div>{r.names[p.team]} {p.name}: {p.rushAtt}-{p.rushYds} {p.rushTd ?? 0} TD</div>)}
        {top("recYds", 3).map((p) => <div>{r.names[p.team]} {p.name}: {p.rec ?? 0} rec {p.recYds} yds</div>)}
      </div>
    </div>
  );
}
