import { Client } from '@elastic/elasticsearch';
import { omit } from 'lodash';
import { addScript, Schema } from 'hydrooj';
import DomainModel from 'hydrooj/src/model/domain';
import ProblemModel, { ProblemDoc } from 'hydrooj/src/model/problem';
import * as system from 'hydrooj/src/model/system';
import { iterateAllProblem, iterateAllProblemInDomain } from 'hydrooj/src/pipelineUtils';
import * as bus from 'hydrooj/src/service/bus';

const client = new Client({ node: system.get('elastic-search.url') || 'http://127.0.0.1:9200' });

const indexOmit = ['_id', 'docType', 'data', 'additional_file', 'config', 'stats', 'assign'];
const processDocument = (doc: Partial<ProblemDoc>) => {
    if (doc.content) {
        doc.content = doc.content.replace(/[[\]【】()（）]/g, ' ');
    }
    if (doc.title) {
        doc.title = doc.title.replace(/[[\]【】()（）]/g, ' ')
            .replace(/([a-zA-Z]{2,})(\d+)/, '$1$2 $1 $2');
    }
    if (doc.pid) {
        doc.pid = doc.pid.replace(/([a-zA-Z]{2,})(\d+)/, '$1$2 $1 $2');
    }
    return omit(doc, indexOmit);
};

bus.on('problem/add', async (doc, docId) => {
    await client.index({
        index: 'problem',
        id: `${doc.domainId}/${docId}`,
        document: processDocument(doc),
    });
});
bus.on('problem/edit', async (pdoc) => {
    await client.index({
        index: 'problem',
        id: `${pdoc.domainId}/${pdoc.docId}`,
        document: processDocument(pdoc),
    });
});
bus.on('problem/del', async (domainId, docId) => {
    await client.delete({
        index: 'problem',
        id: `${domainId}/${docId}`,
    });
});

global.Hydro.lib.problemSearch = async (domainId, q, opts) => {
    const allowedSize = system.get('elasic-search.indexSize') || 10000;
    const size = opts?.limit || system.get('pagination.problem');
    const from = Math.min(allowedSize - size, opts?.skip || 0);
    const union = await DomainModel.getUnion(domainId);
    const domainIds = [domainId, ...(union?.union || [])];
    const res = await client.search({
        index: 'problem',
        size,
        from,
        query: {
            simple_query_string: {
                query: q,
                fields: ['tag^5', 'pid^4', 'title^3', 'content'],
            },
        },
        post_filter: {
            bool: {
                minimum_should_match: 1,
                should: domainIds.map((i) => ({ match: { domainId: i } })),
            },
        },
    });
    return {
        countRelation: typeof res.hits.total === 'number' ? 'eq' : res.hits.total.relation,
        total: typeof res.hits.total === 'number' ? res.hits.total : res.hits.total.value,
        hits: res.hits.hits.map((i) => i._id),
    };
};

async function run({ domainId }, report) {
    try {
        if (domainId) await client.deleteByQuery({ index: 'problem', query: { match: { domainId } } });
        else await client.deleteByQuery({ index: 'problem', query: { match_all: {} } });
    } catch (e) {
        if (!e.message.includes('index_not_found_exception')) throw e;
    }
    let i = 0;
    const cb = async (pdoc) => {
        i++;
        if (!(i % 1000)) report({ message: `${i} problems indexed` });
        await client.index({
            index: 'problem',
            id: `${pdoc.domainId}/${pdoc.docId}`,
            document: processDocument(pdoc),
        });
    };
    if (domainId) await iterateAllProblemInDomain(domainId, ProblemModel.PROJECTION_PUBLIC, cb);
    else await iterateAllProblem(ProblemModel.PROJECTION_PUBLIC, cb);
    await client.indices.refresh({ index: 'problem' });
    return true;
}

addScript('ensureElasticSearch', 'Elastic problem search re-index')
    .args(Schema.object({
        domainId: Schema.string(),
    }))
    .action(run);
