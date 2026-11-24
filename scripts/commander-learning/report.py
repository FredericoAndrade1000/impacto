"""Static, read-only results with a full-period link for every verified episode."""
import argparse
from collections import Counter
from html import escape
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', required=True)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--title', default='Comandantes: recompensas e avaliação')
    parser.add_argument('--preflight-url')
    args = parser.parse_args()
    root, destination = Path(args.run), Path(args.directory)
    destination.mkdir(parents=True, exist_ok=True)
    read = lambda name: json.loads((root / name).read_text(encoding='utf-8')) if (root / name).exists() else {}
    summary, checkpoint, spec = read('summary.json'), read('checkpoint.json'), read('run.json')
    arms = ('standard', 'discovery') if spec['reward'] == 'compare' else (spec['reward'],)
    def journal(name):
        path = root / name
        data = path.read_text(encoding='utf-8') if path.exists() else ''
        # An exporter may still be appending. Malformed complete rows fail;
        # the unfinished last row is admitted after its terminating newline.
        return [json.loads(line) for line in data[:data.rfind('\n') + 1].splitlines()]
    episodes = journal('episodes.ndjson')
    audits = {r['episode']: r for r in journal('replays.ndjson')}
    by_name = {e['name']: e for e in episodes}
    generations = summary.get('generations', checkpoint.get('generations', []))
    number = lambda n: f'{n:,}'.replace(',', '.')
    score = lambda n: f'{n:.4f}'.replace('.', ',')
    def duration(seconds):
        value = round(seconds)
        return f'{value // 3600}h{value // 60 % 60:02}min{value % 60:02}s'
    outcomes = {'horizon': 'Parcial · limite de tempo', 'duel-win': 'Vitória definitiva', 'duel-loss': 'Derrota definitiva',
                'duel-draw': 'Empate definitivo', 'base-captured': 'Captura local · arena', 'base-lost': 'Perda da base · arena'}
    def link(name, label='Replay integral'):
        item = audits.get(name)
        return f'<a href="{escape(item["url"])}">{escape(label)}</a>' if item else '<span class="muted">Verificação pendente</span>'
    def table(headings, rows):
        return '<div class="scroll"><table><thead><tr>' + ''.join(f'<th>{escape(h)}</th>' for h in headings) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join(f'<td>{v}</td>' for v in row) + '</tr>' for row in rows) + '</tbody></table></div>'
    def page(name, title, content):
        html = f'''<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(title)}</title>
<style>:root{{font-family:system-ui,sans-serif;color:#e2e7d8;background:#101b17;line-height:1.6}}body{{max-width:1180px;margin:auto;padding:32px 22px}}h1{{font-size:clamp(26px,4vw,42px);line-height:1.18}}h2{{margin-top:36px;color:#f1bb75}}a{{color:#efbe7e}}a:hover{{color:white}}p{{max-width:86ch}}.muted,small{{color:#aab8a9}}.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:28px 0}}article{{background:#1c2b23;border:1px solid #3e5144;border-radius:12px;padding:18px}}article strong{{display:block;font-size:25px}}.scroll{{overflow:auto}}table{{width:100%;border-collapse:collapse;font-size:14px}}td,th{{padding:10px;text-align:left;border-bottom:1px solid #3e5144;vertical-align:top}}th{{color:#f1bb75}}nav{{display:flex;gap:18px;flex-wrap:wrap}}code{{overflow-wrap:anywhere}}</style>
<nav><a href="index.html">Visão geral</a><a href="episodes-1.html">Todos os episódios</a></nav><h1>{escape(title)}</h1>{content}</html>'''
        (destination / name).write_text(html, encoding='utf-8')
    total = sum(e['simulatedSeconds'] for e in episodes)
    candidate_count = summary.get('candidateEvaluations', sum(len(g['arms']) * spec.get('population', 0) * len(g['cases']) for g in generations))
    cards = '<div class="cards">' + ''.join(f'<article><small>{title}</small><strong>{value}</strong></article>' for title, value in [
        ('Avaliações em gerações concluídas', number(candidate_count)), ('Partidas físicas únicas', number(len(episodes))),
        ('Tempo total simulado', duration(total)), ('Replays integrais verificados', f'{number(len(audits))} / {number(len(episodes))}')]) + '</div>'
    experiment = ('com e sem um bônus limitado por novas descobertas úteis' if spec['reward'] == 'compare' else
                  'com bônus limitado por novas descobertas úteis no treino' if spec['reward'] == 'discovery' else 'com desempate econômico limitado')
    content = f'<p>Comparação em CPU entre o comandante clássico e uma pequena rede econômica, {experiment}. Física Native a 60 Hz, custos, kit inicial e neblina de guerra normais. Nenhuma mudança no servidor público.</p>' + cards
    content += f'<p>Pontuação versão {spec["scoreVersion"]} · até {spec["generations"]} gerações · {spec["population"]} candidatos por braço. As notas de versões diferentes não são comparáveis diretamente.</p>'
    if len(arms) > 1:
        content += '<p>Partidas idênticas entre os braços compartilham a mesma gravação. <strong>Avaliações de candidatos não são partidas adicionais.</strong></p>'
    content += '<p>Um replay cobre todo o período simulado, com todos os capítulos em sequência; “parcial” significa que a partida atingiu seu horizonte sem um vencedor.</p>'
    if args.preflight_url:
        content += f'<p><a href="{escape(args.preflight_url)}">Ver o pré-teste separado</a></p>'
    if summary:
        if generations and all(arm['selected'] == 0 for g in generations for arm in g['arms'].values()):
            content += '<p><strong>O modelo inicial, que conserva as escolhas clássicas, foi mantido em todas as gerações.</strong> A busca não encontrou um candidato superior nos conjuntos de treino. Isso não demonstra melhora da IA adversária.</p>'
        schema = summary.get('modelSchema')
        if schema:
            content += f'<p>Modelo v{schema["version"]}: {schema["inputs"]} entradas, {schema["hidden"]} unidades internas e {schema["parameters"]} parâmetros. Uma alternativa precisa superar a nota clássica por mais de {score(schema["baselineMargin"])}. Essa margem não é uma probabilidade de acerto.</p>'
        stability = read('stability.json')
        if stability:
            content += f'<h2>Estabilidade da seleção</h2><p>Mesmas {number(stability["states"])} observações clássicas com múltiplas escolhas; 16 perturbações pareadas por escala. Diagnóstico matemático, sem partidas adicionais. Mede mudanças de escolha, não força de jogo.</p>'
            content += table(['Perturbação (σ)', 'Troca do clássico: sem margem', 'Com margem'], [[
                f'{r["sigma"]:g}', f'{100 * r["withoutMargin"]:.2f}%', f'{100 * r["withMargin"]:.2f}%'] for r in stability['measurements']])
        final = summary.get('holdout', [])
        if final:
            success, failure = ('duel-win', 'base-captured'), ('duel-loss', 'base-lost')
            def outcome_counts(rows, side):
                outcomes = Counter(row[side + 'Outcome'] for row in rows)
                return sum(outcomes[k] for k in success), sum(outcomes[k] for k in failure), outcomes['horizon']
            baseline, model = outcome_counts(final, 'baseline'), outcome_counts(final, 'model')
            favored = ((model[0] > baseline[0] and model[1] <= baseline[1]) or
                       (model[1] < baseline[1] and model[0] >= baseline[0]))
            interpretation = ('O finalista teve mais sucessos sem mais perdas, ou menos perdas sem menos sucessos, neste conjunto.' if favored else
                              'O teste reservado não confirmou vantagem global do finalista sobre o clássico.')
            content += '<h2>Resultado nos cenários reservados</h2><p><strong>' + interpretation + '</strong> O comandante clássico continua sendo o padrão; não houve promoção automática.</p>'
            content += '<p>Sucesso significa vitória definitiva em duelo ou captura local em arena. Uma arena continua tendo outras facções após essa captura. Partidas no limite de tempo são parciais.</p>'
            groups = [('Duelos', [r for r in final if r['factions'] == 2]), ('Arenas', [r for r in final if r['factions'] == 4]), ('Todos', final)]
            result_rows = []
            for label, rows in groups:
                if not rows:
                    continue
                classic, learned = outcome_counts(rows, 'baseline'), outcome_counts(rows, 'model')
                result_rows.append([label, number(len(rows)), str(classic[0]), str(classic[1]), str(learned[0]), str(learned[1]), f'{classic[2]} / {learned[2]}'])
            content += table(['Cenários', 'Por política', 'Clássico: sucessos', 'Clássico: perdas', 'Rede: sucessos', 'Rede: perdas', 'Parciais: clássico / rede'], result_rows)
            content += '<p>A avaliação usa a nota comum, sem bônus por descoberta. Uma única semente do otimizador e poucos encerramentos por objetivo limitam a conclusão sobre força de jogo.</p>'
        content += '<h2>Avaliação de desenvolvimento</h2><p>Comparação pareada em cenários separados do treino, usando apenas objetivos e capital limitado; descobrir locais não aumenta a nota de avaliação. Não há promoção automática para produção.</p>'
        content += table(['Braço', 'Sucessos: clássico → rede', 'Perdas: clássico → rede', 'Diferença média', 'Portão de objetivos'], [
            [escape(r), f'{v["baselineSuccesses"]} → {v["modelSuccesses"]}', f'{v["baselineLosses"]} → {v["modelLosses"]}', score(v['meanDifference']), 'Passou' if v['passed'] else 'Rejeitado'] for r, v in summary['evidence'].items()])
        if summary.get('holdoutStatus') == 'rejected-at-development':
            content += '<p>Os modelos não melhoraram os objetivos na avaliação de desenvolvimento. Os 100 cenários finais reservados não foram usados para escolher ou retreinar esses modelos.</p>'
        for phase, title in [('evaluation', 'Cenários de desenvolvimento'), ('holdout', 'Teste final reservado')]:
            rows = summary.get(phase, [])
            if rows:
                content += '<h2>' + title + '</h2>' + table(['Cenário / braço', 'Clássico', 'Rede', 'Δ nota comum'], [[
                    escape(r['name'] + ' / ' + r['arm']), link(r['baselineEpisode'], outcomes[r['baselineOutcome']] + ' · ' + duration(r['baselineSeconds'])),
                    link(r['modelEpisode'], outcomes[r['modelOutcome']] + ' · ' + duration(r['modelSeconds'])), score(r['difference'])] for r in rows])
    else:
        content += '<p><strong>Em execução.</strong> Nenhum vencedor do experimento foi declarado. Os totais mostram apenas episódios já concluídos.</p>'
    arm_labels = {'standard': 'Sem bônus: candidato / ganho', 'discovery': 'Descobertas: candidato / ganho'}
    content += '<h2>Gerações</h2>' + table(['Geração', *[arm_labels[r] for r in arms], 'Gravações pareadas'], [[
        str(g['generation'] + 1), *[f'{g["arms"][r]["selected"]} / {score(g["arms"][r]["improvementOverIncumbent"])}' if r in g['arms'] else 'Parado por estagnação' for r in arms],
        f'<a href="generation-{g["generation"] + 1}.html">Todas as tentativas</a>'] for g in generations])
    counts = Counter(e['outcome'] for e in episodes)
    content += '<h2>Encerramentos das partidas únicas</h2>' + table(['Resultado', 'Quantidade'], [[outcomes[k], number(v)] for k, v in counts.items()])
    stopping = f'Parada antecipada: {spec["patience"]} gerações sem melhora sobre o incumbente nos cenários pareados da geração.' if spec['patience'] else 'Sem parada antecipada por estagnação nesta rodada.'
    content += '<h2>Limites da interpretação</h2><p>Uma única semente do otimizador por braço; adversários clássicos fixos; o mesmo mundo físico, com regiões, posições e distâncias variadas. O capital contabiliza Ferro e valor residual das próprias construções, não toda a economia. O sinal de descoberta altera a preferência de treino e pode não melhorar combate ou progressão. Arenas param na primeira captura ou perda da facção avaliada, sem declarar vitória eliminatória.</p><p>' + stopping + ' O portão de desenvolvimento exige mais sucessos sem mais perdas, ou menos perdas sem menos sucessos. Não há promoção automática.</p>'
    if audits:
        content += '<p>Cada replay marcado como verificado confere todos os prints Native, a continuidade dos quadros visuais, os disparos primários e os hashes dos originais e pacotes preparados.</p>'
    page('index.html', args.title, content)
    for generation in generations:
        rows = []
        for alias, cases in generation['episodes'].items():
            for case, name in cases.items():
                item = by_name[name]
                rows.append([escape(alias), escape(case), score(item['scores']['standard']), score(item['scores']['discovery']),
                             duration(item['simulatedSeconds']), outcomes[item['outcome']], link(name)])
        page(f'generation-{generation["generation"] + 1}.html', f'Geração {generation["generation"] + 1}: todas as tentativas',
             '<p>Uma mesma partida pode aparecer nos dois braços. Todos os links levam ao período inteiro.</p>' + table(['Candidato', 'Cenário', 'Nota comum', 'Com descobertas', 'Duração', 'Encerramento', 'Gravação'], rows))
    for start in range(0, max(1, len(episodes)), 100):
        index = start // 100 + 1
        nav = '<nav>' + ' '.join(f'<a href="episodes-{i}.html">{i}</a>' for i in range(1, (len(episodes) + 99) // 100 + 1)) + '</nav>'
        rows = [[escape(e['name']), escape(e['phase']), f'{e["factions"]} / {e["slot"] + 1}',
                 f'{e["spacing"]} m / {e["center"]} m', duration(e['simulatedSeconds']), outcomes[e['outcome']], link(e['name'])] for e in episodes[start:start + 100]]
        page(f'episodes-{index}.html', f'Todas as partidas únicas · página {index}', nav + table(['Episódio', 'Etapa', 'Facções / posição', 'Distância / região', 'Duração', 'Encerramento', 'Replay integral'], rows) + nav)
    print(json.dumps(dict(portal=str(destination / 'index.html'), episodes=len(episodes), verified=len(audits))))


if __name__ == '__main__':
    main()
