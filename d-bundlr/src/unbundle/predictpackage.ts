import {FunctionPrototype} from "./verifypackageis";
import axios from 'axios';

export type PredictFunction = {
    function: Omit<FunctionPrototype, "isEsModule" | "packageVersion">,
    confidence: number
};

const PREDICT_SERVER = process.env.PREDICT_SERVER || "http://127.0.0.1:8000/";

export async function query(inputString: string, topn: number = 3): Promise<Array<PredictFunction>> {
    const url = `${PREDICT_SERVER}/predict`;
    const payload = { code: inputString, topn: topn};

    const response = await axios.post(url, payload);
    return response.data as Array<PredictFunction>;
}
