# Guia de deploy na AWS e roteiro de medição

Este guia monta, do zero, o ambiente de medição do projeto na AWS e roda os cenários que geram os
dados pedidos no Tema 10: latência (percentis), vazão, hit rate, carga no banco, janela de
desatualização, exemplo de invalidação, métricas do CloudWatch e custos.

Não é preciso conhecer a AWS: cada conceito novo é explicado no passo em que aparece, em blocos
**Conceito**. Tudo é feito pelo **console web da AWS** e por **SSH** nas máquinas. Nada precisa ser
instalado no seu computador além de um cliente SSH (Linux, macOS e Windows 10+ já têm).

**Tempo estimado:** ~1 h 30 min para montar (a maior parte é esperar recursos ficarem prontos),
~1 h para medir e ~15 min para desmontar.
**Custo estimado:** ~US$ 0,30 por hora com tudo ligado (detalhes em [Custos](#13-custos)).
**Não esqueça o [passo 14 (desmontar)](#14-desmontar-tudo):** recurso esquecido ligado continua cobrando.

## Sumário

1. [O que vamos montar](#1-o-que-vamos-montar)
2. [Antes de começar: conta, região e alerta de gastos](#2-antes-de-começar-conta-região-e-alerta-de-gastos)
3. [Rede (VPC)](#3-rede-vpc)
4. [Security groups (firewall)](#4-security-groups-firewall)
5. [Par de chaves (SSH)](#5-par-de-chaves-ssh)
6. [As três máquinas (EC2)](#6-as-três-máquinas-ec2)
7. [EC2 do MongoDB](#7-ec2-do-mongodb)
8. [ElastiCache (o cache)](#8-elasticache-o-cache)
9. [EC2 da API](#9-ec2-da-api)
10. [EC2 do gerador de carga](#10-ec2-do-gerador-de-carga)
11. [Roteiro de medição (os cenários)](#11-roteiro-de-medição-os-cenários)
12. [Trazer os resultados e gerar os gráficos](#12-trazer-os-resultados-e-gerar-os-gráficos)
13. [Custos](#13-custos)
14. [Desmontar tudo](#14-desmontar-tudo)
15. [Problemas comuns](#15-problemas-comuns)

---

## 1. O que vamos montar

```
 Seu computador ──SSH (porta 22)──► as três EC2 (só a partir do seu IP)

 VPC tema10 (rede privada 10.0.0.0/16), zona us-east-1a
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ Subnet pública                                                             │
 │  ┌─────────────────┐   :3000    ┌──────────────┐  :27017  ┌──────────────┐ │
 │  │ EC2 gerador     │ ─────────► │ EC2 API      │ ───────► │ EC2 MongoDB  │ │
 │  │ k6 (run.sh)     │            │ container    │          │ container    │ │
 │  └────────┬────────┘            │ products-api │          │ mongo:8.0    │ │
 │           │                     └──────┬───────┘          └──────────────┘ │
 │           │ :6379 (só FLUSHDB          │ :6379 (TLS)                       │
 │           │  entre execuções)          │                                   │
 │ Subnet privada                         ▼                                   │
 │           │                     ┌─────────────────────┐                    │
 │           └───────────────────► │ ElastiCache (Valkey)│                    │
 │                                 │ 1 nó, sem réplica   │                    │
 │                                 └─────────────────────┘                    │
 └────────────────────────────────────────────────────────────────────────────┘
```

| Máquina | O que roda | Por quê separada |
|---|---|---|
| **EC2 MongoDB** | container `mongo:8.0` (`compose.yaml`, serviço `mongo`) | A capacidade do banco fica conhecida e isolada: dá para separar o ganho do cache do limite do banco |
| **ElastiCache** | Valkey (compatível com Redis), gerenciado pela AWS | É o que o tema pede: cache distribuído acessível só pela rede privada |
| **EC2 API** | container `products-api` (`compose.yaml`, serviço `api`) | É o sistema medido; a estratégia de cache muda só no `.env` |
| **EC2 gerador** | `loadtest/run.sh` (k6 em container) | Gera carga **de dentro** da rede da AWS, sem a latência da internet, e sem disputar CPU com a API |

O código é o mesmo que roda localmente. Na AWS, cada máquina sobe **só o seu serviço** com
`docker compose -f compose.yaml ...`. O `-f compose.yaml` ignora o `compose.override.yaml`, que é só
para uso local. O serviço `redis` do compose não é usado: o Redis na AWS é o ElastiCache.

---

## 2. Antes de começar: conta, região e alerta de gastos

1. Entre no console: <https://console.aws.amazon.com>.
2. **Escolha a região `us-east-1` (N. Virginia)** no canto superior direito, e use **a mesma região
   em todos os passos**.

> **Conceito: região e zona de disponibilidade (AZ).** A AWS tem data centers no mundo todo,
> agrupados em **regiões** (ex.: `us-east-1`, na Virgínia). Cada região tem várias **zonas de
> disponibilidade** (`us-east-1a`, `us-east-1b`...): prédios separados, ligados por rede rápida.
> Recursos de regiões diferentes não se enxergam pela rede privada. Por isso tudo fica na mesma
> região. E tudo fica na **mesma AZ**: entre AZs a latência aumenta (~0,5–1 ms) e o tráfego é cobrado.
> Escolhemos `us-east-1` por ser a região mais barata e a única liberada no AWS Academy.

3. **Crie um alerta de gastos.** Busque **Budgets** na barra de busca → *Create budget* → *Use a
   template* → *Monthly cost budget*. Coloque um valor (ex.: US$ 10) e o seu e-mail.

> **Conceito: Budgets.** A AWS cobra por uso (por hora ou por GB). O Budgets envia um e-mail quando o
> gasto do mês passa do valor escolhido. Ele **não desliga nada sozinho**: só avisa.

**Se a conta for do AWS Academy (Learner Lab):**
- abra o console pelo botão do laboratório;
- use o par de chaves `vockey`, que já existe (pule o passo 5);
- quando a sessão expira, o laboratório **desliga as EC2**. Ao religá-las, o IP público muda (o
  privado não), e os containers voltam sozinhos (`restart: unless-stopped`);
- planeje medir tudo numa sessão só;
- se algum tipo de máquina deste guia não for permitido, use o equivalente x86 da tabela do passo 6.

**Convenção de nomes:** tudo que você criar começa com `tema10-`, para achar (e apagar) depois.

---

## 3. Rede (VPC)

> **Conceito: VPC (Virtual Private Cloud).** É a sua rede privada isolada dentro da AWS, com uma
> faixa de IPs só sua (aqui `10.0.0.0/16`, ou seja, endereços `10.0.x.x`). Máquinas na mesma VPC se
> falam pelos **IPs privados**; ninguém de fora entra, a não ser que você libere.
>
> **Conceito: subnet pública e privada.** A VPC é dividida em **subnets** (sub-redes), cada uma numa
> AZ. Uma subnet é **pública** quando tem rota para o **Internet Gateway** (a "porta" da VPC para a
> internet). Uma subnet **privada** não tem essa rota: o que está nela só é alcançável de dentro da
> VPC. As EC2 ficam na pública (para você entrar por SSH e para elas baixarem imagens Docker). O
> ElastiCache fica na privada, como o tema pede.

1. Busque **VPC** → *Create VPC*.
2. Escolha **VPC and more**: o assistente cria a VPC, as subnets, o Internet Gateway e as tabelas de
   rotas de uma vez.
3. Preencha:

| Campo | Valor | Observação |
|---|---|---|
| Name tag auto-generation | `tema10` | prefixo dos nomes |
| IPv4 CIDR block | `10.0.0.0/16` | padrão |
| Number of Availability Zones | **1** | tudo na mesma AZ |
| Customize AZs | `us-east-1a` | |
| Number of public subnets | 1 | EC2 |
| Number of private subnets | 1 | ElastiCache |
| NAT gateways | **None** | NAT custa ~US$ 33/mês e não é necessário aqui |
| VPC endpoints | None (ou o S3 Gateway, que é grátis) | |
| DNS hostnames / DNS resolution | ambos marcados | o endpoint do ElastiCache é um nome DNS |

4. *Create VPC*. Em menos de um minuto aparecem `tema10-vpc`, `tema10-subnet-public1-us-east-1a` e
   `tema10-subnet-private1-us-east-1a`.

---

## 4. Security groups (firewall)

> **Conceito: security group (SG).** É o firewall de cada recurso: uma lista de regras de **entrada**
> ("quem pode me acessar, em qual porta"). Tudo que não está liberado é bloqueado. A saída é liberada
> por padrão. A origem de uma regra pode ser um IP ou **outro security group**. "Porta 27017 a partir
> do SG da API" significa: só máquinas que usam o SG da API entram no Mongo, qualquer que seja o IP
> delas. São os **security groups encadeados**: cada camada só aceita a camada anterior.

Crie quatro SGs em **VPC → Security groups → Create security group**. Em **VPC**, escolha sempre
`tema10-vpc` (não a VPC *default*). Crie **nesta ordem**, porque cada um referencia os anteriores:

| Nome | Regras de entrada (Type / Port / Source) | Para quê |
|---|---|---|
| `tema10-loadgen-sg` | SSH / 22 / **My IP** | você entra no gerador |
| `tema10-api-sg` | SSH / 22 / My IP<br>Custom TCP / **3000** / `tema10-loadgen-sg` | só o gerador chama a API |
| `tema10-mongo-sg` | SSH / 22 / My IP<br>Custom TCP / **27017** / `tema10-api-sg` | só a API acessa o banco |
| `tema10-cache-sg` | Custom TCP / **6379** / `tema10-api-sg`<br>Custom TCP / **6379** / `tema10-loadgen-sg` | a API usa o cache; o gerador só faz `FLUSHDB` entre execuções |

- Na coluna *Source*, digite `sg-` ou o nome do grupo para escolher outro SG.
- *My IP* preenche o IP atual da sua internet. Se você mudar de rede (casa → universidade), o SSH para
  de funcionar até você editar a regra (veja [Problemas comuns](#15-problemas-comuns)).
- Ninguém na internet alcança a API, o Mongo ou o cache. Tudo é testado de dentro da VPC.

---

## 5. Par de chaves (SSH)

> **Conceito: key pair.** As EC2 não usam senha para SSH. A AWS guarda a chave pública na máquina e
> você baixa a chave privada (`.pem`) **uma única vez**. Quem tem o arquivo entra; por isso não o
> compartilhe nem o coloque no Git.

1. **EC2 → Key pairs → Create key pair**: nome `tema10-key`, tipo RSA, formato `.pem`.
2. O download começa sozinho. Guarde o arquivo e restrinja a permissão (o SSH recusa chaves que
   outros usuários podem ler):

```bash
mkdir -p ~/.ssh && mv ~/Downloads/tema10-key.pem ~/.ssh/ && chmod 400 ~/.ssh/tema10-key.pem
```

No Windows (PowerShell), os mesmos comandos `ssh`/`scp` funcionam. Se o SSH reclamar de permissões,
remova o acesso de outros usuários ao arquivo em *Propriedades → Segurança*.

---

## 6. As três máquinas (EC2)

> **Conceito: EC2 e AMI.** Uma **instância EC2** é uma máquina virtual alugada por hora (ou por
> segundo). O **tipo** define CPU e memória: `c7g.large` tem 2 vCPUs e 4 GiB. O `g` indica processador
> **Graviton** (ARM), ~20% mais barato que o x86 equivalente. A **AMI** é a imagem do sistema
> operacional instalada no disco; usamos Ubuntu 24.04. Todas as imagens Docker do projeto (Node,
> Mongo, k6, Redis, Python) existem para ARM e x86.

| Nome | Tipo (ARM) | Equivalente x86 | Por quê |
|---|---|---|---|
| `tema10-mongo` | `m7g.medium` (1 vCPU, 4 GiB) | `m6i.large` | CPU fixa (não "burstable"): a capacidade do banco não varia entre testes |
| `tema10-api` | `c7g.large` (2 vCPU, 4 GiB) | `c6i.large` | Node usa 1 núcleo; o outro fica para o sistema e o Docker |
| `tema10-loadgen` | `c7g.xlarge` (4 vCPU, 8 GiB) | `c6i.xlarge` | O k6 precisa de folga de CPU, senão quem limita o teste é o gerador e não a API |

Repita para cada uma: **EC2 → Instances → Launch instances**.

| Campo | Valor |
|---|---|
| Name | `tema10-mongo` / `tema10-api` / `tema10-loadgen` |
| AMI | **Ubuntu Server 24.04 LTS**, arquitetura **64-bit (Arm)** (ou x86, se usar os tipos x86) |
| Instance type | da tabela acima |
| Key pair | `tema10-key` (no Academy: `vockey`) |
| Network settings → **Edit** | VPC `tema10-vpc`; subnet `tema10-subnet-public1-us-east-1a`; **Auto-assign public IP: Enable** (vem desligado em VPCs novas: sem IP público não há SSH) |
| Firewall (security groups) | *Select existing* → o SG da máquina (`tema10-mongo-sg`, `tema10-api-sg` ou `tema10-loadgen-sg`) |
| Configure storage | **20 GiB gp3** (o padrão de 8 GiB enche com as imagens Docker) |
| Advanced details → Detailed CloudWatch monitoring | **Enable** (métricas a cada 1 min em vez de 5; custa centavos) |

> **Conceito: IP público e IP privado.** Cada EC2 recebe um **IP privado** (`10.0.x.x`), usado entre
> as máquinas e que nunca muda. Com *Auto-assign public IP*, recebe também um **IP público**, usado só
> para o seu SSH, que **muda** se a máquina for desligada e religada. Os dois aparecem na página da
> instância (*Public IPv4 address* e *Private IPv4 addresses*).

Quando as três estiverem *Running* com *Status check: 2/2 passed* (~2 min), **anote numa tabela**:

| Máquina | IP público (SSH) | IP privado (configuração) |
|---|---|---|
| tema10-mongo | | |
| tema10-api | | |
| tema10-loadgen | | |

### Instalar Docker (nas três máquinas)

Entre em cada máquina (o usuário do Ubuntu é `ubuntu`) e rode:

```bash
ssh -i ~/.ssh/tema10-key.pem ubuntu@<IP público>

curl -fsSL https://get.docker.com | sudo sh     # Docker + plugin compose (script oficial)
sudo usermod -aG docker ubuntu                  # usar docker sem sudo
exit                                            # saia e entre de novo para o grupo valer
```

Entre de novo e confira, já baixando o projeto:

```bash
docker compose version                          # Docker Compose version v2.x
git clone https://github.com/KauaLessa/products-cache-api.git
cd products-cache-api
```

Dica: deixe **um terminal aberto em cada máquina**. Durante as medições você vai alternar entre o
da API e o do gerador.

---

## 7. EC2 do MongoDB

Na máquina `tema10-mongo`:

```bash
cd ~/products-cache-api
cat > .env <<'EOF'
MONGO_ROOT_USERNAME=admin
MONGO_ROOT_PASSWORD=TroqueEstaSenha123
EOF
docker compose -f compose.yaml up -d --wait mongo
docker compose -f compose.yaml ps            # mongo ... (healthy)
```

- **Use uma senha só com letras e números:** ela vai dentro de uma URL na configuração da API, e
  símbolos como `@`, `:` e `/` quebram a URL.
- O Mongo cria o usuário **só na primeira subida**, com o volume vazio. Se trocar a senha depois, a
  antiga continua valendo; use a senha original na API.
- Os dados ficam no volume Docker `mongo-data`, no disco (EBS) da EC2. O container volta sozinho se a
  máquina reiniciar.

> **Conceito: EBS.** É o "disco" das EC2: um volume de rede que guarda os dados mesmo com a máquina
> desligada. É cobrado por GB/mês enquanto existir, mesmo com a EC2 parada.

---

## 8. ElastiCache (o cache)

> **Conceito: ElastiCache.** É o Redis gerenciado pela AWS: ela instala, monitora, aplica correções e
> troca o hardware se falhar. Você escolhe o **engine** (Valkey, Redis OSS ou Memcached), o **tipo de
> nó** (CPU e memória) e quantas réplicas quer. O cluster **só tem IP privado**: só é acessível de
> dentro da VPC, e só pelas origens que o security group liberar.
>
> **Por que Valkey:** é o fork open source do Redis mantido pela Linux Foundation. Fala o mesmo
> protocolo (o código da API não muda) e no ElastiCache custa ~20% menos que o Redis OSS (que também
> funcionaria sem mudar nada). O Memcached fala outro protocolo (a API foi escrita para o do Redis) e
> não tem réplicas, persistência nem estruturas de dados além de texto. Registre essa escolha no
> relatório: o tema pede a comparação.

### 8.1 Subnet group

> **Conceito: subnet group.** É a lista de subnets onde o ElastiCache pode criar os nós. Usamos só a
> subnet privada.

**ElastiCache → Subnet groups → Create subnet group**:
- Name: `tema10-cache-subnets`;
- VPC: `tema10-vpc`;
- Subnets: **só** a `tema10-subnet-private1-us-east-1a` (remova as outras, se vierem marcadas).

### 8.2 Criar o cache

**ElastiCache → Valkey caches → Create Valkey cache**. Os nomes dos campos do console mudam com o
tempo; o que importa são estes valores:

| Opção | Valor | Por quê |
|---|---|---|
| Deployment option | **Design your own cache** (não *Serverless*) | O tema pede parâmetros de nós; o Serverless exige o modo cluster, ainda não testado na API |
| Creation method | Cluster cache | |
| Cluster mode | **Disabled** | Os dados (~40 MB) cabem num nó; um nó é mais simples de interpretar |
| Name | `tema10-cache` | |
| Location | AWS Cloud; **Multi-AZ: off**; Auto-failover: off | Sem réplica, sem custo dobrado |
| Engine version | a mais recente (8.x) | |
| Port | 6379 | |
| Parameter group | `default.valkey8` | veja 8.3 |
| Node type | **`cache.t4g.micro`** (0,5 GiB) | Suficiente para ~100 mil produtos; veja a nota abaixo |
| Number of replicas | **0** | |
| Subnet group | `tema10-cache-subnets` | |
| Availability Zone placement | `us-east-1a` | mesma AZ das EC2 |
| Encryption at rest | ativado (padrão) | |
| **Encryption in transit** | **ativado** | Tráfego com TLS; exige `REDIS_TLS=true` na API |
| Access control | No access control | O acesso já é restrito pela rede (SG); sem senha no `.env` |
| Security groups | **só** `tema10-cache-sg` (remova o *default*) | |
| Automatic backups | **desativado** | Os dados vêm do Mongo; backup só gera custo |

*Create*. Leva **~10–15 min** até o status ficar *Available*. Enquanto isso, siga para o passo 9.

Quando ficar *Available*, abra o cache e copie o **Primary endpoint**, por exemplo
`master.tema10-cache.abc123.use1.cache.amazonaws.com:6379`. Anote **sem o `:6379`**.

> **Nota sobre `cache.t4g.micro`:** nós `t4g` são "burstable": acumulam créditos de CPU quando ociosos
> e os gastam sob carga. Durante os testes, olhe a métrica **CPUCreditBalance** do cache no
> CloudWatch (passo 11.7). Se ela zerar, a CPU do cache é limitada e as medições ficam distorcidas:
> recrie com `cache.t4g.small` ou `cache.m7g.large` e repita.

### 8.3 Conferir a política de eviction

> **Conceito: eviction.** Quando a memória do cache enche, o Valkey apaga chaves para abrir espaço,
> conforme a `maxmemory-policy`. A API guarda um contador de geração da listagem **sem TTL**. Com
> `volatile-lru` (o padrão), só chaves **com TTL** são apagadas, então o contador nunca é perdido. Com
> uma política `allkeys-*`, ele poderia ser apagado e páginas velhas da listagem voltariam a ser
> servidas.

**ElastiCache → Parameter groups → `default.valkey8`** → procure `maxmemory-policy` → deve ser
`volatile-lru`. Registre o valor no relatório (é um "parâmetro de nó").

---

## 9. EC2 da API

Na máquina `tema10-api`, preencha as três variáveis e rode o bloco inteiro. Ele cria o `.env` da API.

```bash
cd ~/products-cache-api
MONGO_IP=10.0.x.x                      # IP PRIVADO da tema10-mongo
MONGO_PASSWORD=TroqueEstaSenha123      # a mesma do passo 7
CACHE_ENDPOINT=master.tema10-cache.abc123.use1.cache.amazonaws.com   # sem :6379

cat > .env <<EOF
PORT=3000
NODE_ENV=production
MONGODB_URI=mongodb://admin:${MONGO_PASSWORD}@${MONGO_IP}:27017/products?authSource=admin
MONGODB_MAX_POOL_SIZE=20
MONGODB_SERVER_SELECTION_TIMEOUT_MS=5000
CACHE_STRATEGY=none
CACHE_TTL_SECONDS=60
CACHE_KEY_PREFIX=products-api:
CACHE_INVALIDATE_ON_WRITE=true
REDIS_HOST=${CACHE_ENDPOINT}
REDIS_PORT=6379
REDIS_USERNAME=
REDIS_PASSWORD=
REDIS_TLS=true
REDIS_CLUSTER_MODE=false
REDIS_CONNECT_TIMEOUT_MS=5000
REDIS_COMMAND_TIMEOUT_MS=1000
EOF

docker compose -f compose.yaml up -d --build --wait api    # build da imagem: ~1–2 min
curl -s localhost:3000/health; echo
```

Esperado: `{"status":"ok","services":{"mongo":"up","redis":"disabled"}}`. O Redis fica `disabled`
porque a estratégia começa em `none`. Se o comando falhar, veja os logs com
`docker compose -f compose.yaml logs api`.

### 9.1 Dados (seed)

```bash
docker compose -f compose.yaml exec -T api node scripts/seed.js --count 100000
```

O seed é **determinístico**: o mesmo `--count` gera sempre os mesmos produtos (ids `1..100000`,
descrição de 200 caracteres). Isso permite repetir as medições e informar a quantidade exata de dados.

Por que 100 mil e não os 10 mil usados localmente: com 10 mil chaves, todas entram no cache em
segundos e as distribuições `hotset` e `uniform` dão o mesmo hit rate. Com 100 mil, a distribuição de
acesso faz diferença no resultado. O valor de `PRODUCTS` no gerador (passo 10) **tem de ser igual**.

### 9.2 Trocar a configuração da API

Cada cenário pede uma configuração da API. O script `scripts/api-config.sh` altera o `.env`, recria o
container e mostra a configuração com que a API subiu:

```
scripts/api-config.sh <none|cache-aside|write-through> [TTL em segundos, padrão 60] [invalidar na escrita: true|false, padrão true]
```

Teste agora:

```bash
scripts/api-config.sh cache-aside
# [api] listening on port 3000 (env: production, cache strategy: cache-aside, ttl: 60s, invalidate on write: true)
curl -s localhost:3000/health; echo     # agora "redis":"up"
```

Se o Redis aparecer como `down` ou `degraded`, veja [Problemas comuns](#15-problemas-comuns) antes de
seguir.

---

## 10. EC2 do gerador de carga

Na máquina `tema10-loadgen`, crie o arquivo de configuração dos testes **uma única vez**. Os scripts
de teste o leem sozinhos; ele fica fora do Git e continua valendo depois de reconectar.

```bash
cd ~/products-cache-api
cp loadtest/aws.env.example loadtest/aws.env
nano loadtest/aws.env       # preencha API_URL e REDIS_URL; Ctrl+O, Enter salva, Ctrl+X sai
```

Valores (só as duas primeiras linhas mudam: o **IP privado** da `tema10-api` e o endpoint do cache;
não acrescente comentários na mesma linha de um valor):

```
API_URL=http://10.0.x.x:3000
REDIS_URL=rediss://master.tema10-cache.abc123.use1.cache.amazonaws.com:6379
PRODUCTS=100000
DURATION=60s
WARMUP_SECONDS=10
RESULTS=results-aws
```

| Variável | Por quê |
|---|---|
| `API_URL` | O gerador fala com a API pelo IP privado, dentro da VPC |
| `REDIS_URL` | Antes de cada execução, o `run.sh` esvazia o cache (`FLUSHDB`), para nenhuma execução herdar chaves da anterior. `rediss://` (com dois "s") = com TLS |
| `PRODUCTS` | Igual ao seed |
| `DURATION`, `WARMUP_SECONDS` | Fase medida de 60 s depois de 10 s de aquecimento (descartado das métricas) |
| `RESULTS=results-aws` | Os resultados da AWS ficam em `loadtest/results-aws/`, separados dos locais |

Uma variável escrita na frente do comando vale mais que o arquivo. Por exemplo,
`RESULTS=results-aws-cold loadtest/run.sh` grava em outra pasta só naquela execução.

Confira a conectividade:

```bash
source loadtest/aws.env                                                          # só para estes testes
curl -s "$API_URL/health"; echo                                                  # status ok
docker run --rm --network host redis:7.4-alpine redis-cli -u "$REDIS_URL" PING   # PONG
```

Registre os parâmetros do ambiente: o tema pede que o relatório informe quantidade de dados,
distribuição e warm-up. Na mesma sessão do `source` acima, rode o bloco abaixo e depois preencha os
`<...>` com `nano loadtest/results-aws/ENVIRONMENT.md`:

```bash
mkdir -p loadtest/results-aws
cat > loadtest/results-aws/ENVIRONMENT.md <<EOF
# AWS measurement environment

- Date (UTC): $(date -u +%F)
- Region / AZ: us-east-1 / us-east-1a
- API: <c7g.large>, Node in Docker, MONGODB_MAX_POOL_SIZE=20
- MongoDB: <m7g.medium>, mongo:8.0 in Docker, EBS gp3 20 GiB
- Load generator: <c7g.xlarge>, k6 grafana/k6:1.3.0
- ElastiCache: <Valkey 8.x>, <cache.t4g.micro>, 1 node, no replicas, cluster mode disabled,
  in-transit encryption on, maxmemory-policy <volatile-lru>
- Data: ${PRODUCTS} products (seed --count ${PRODUCTS}, deterministic, 200-char description)
- Load: closed model, no think time; ${DURATION} measured after ${WARMUP_SECONDS}s warm-up
  (metrics reset after warm-up); cache flushed (FLUSHDB) before each run
- Key distributions: hotset (80% of reads on the first 20% of ids) and uniform
EOF
```

---

## 11. Roteiro de medição (os cenários)

**Como funciona:** deixe dois terminais abertos, ambos em `~/products-cache-api`.
- No **terminal da API**, escolha a configuração com `scripts/api-config.sh`.
- No **terminal do gerador**, meça com `loadtest/run.sh`.

Cada execução salva dois arquivos em `loadtest/results-aws/`:
- `<nome>-k6.json`: a visão do cliente (percentis de latência);
- `<nome>-api.json`: a visão da API (hits, misses, consultas ao Mongo e a configuração ativa).

O nome do arquivo diz a estratégia, a distribuição e o número de clientes. O horário no nome está em
UTC.

**Não rode nada pesado nas máquinas durante uma execução,** nem mesmo o `plot.sh`: CPU disputada
distorce a latência.

| Cenário | Item do tema | Tempo |
|---|---|---|
| 11.1 Baseline sem cache | 1, 5 | ~12 min |
| 11.2 Cache-aside e write-through sob carga | 2, 3, 5 | ~24 min |
| 11.3 Cache frio (warm-up) | ponto de atenção "não medir só a execução quente" | ~3 min |
| 11.4 Janela de desatualização | 4 | ~3 min |
| 11.5 Exemplo de invalidação | 4, entregável "exemplo de invalidação" | ~2 min |
| 11.6 Falha do cache no write-through (opcional) | 3 | ~3 min |
| 11.7 CloudWatch | operação: métricas CloudWatch | durante 11.1–11.2 |

### 11.1 Baseline sem cache

| Terminal da API | Terminal do gerador |
|---|---|
| `scripts/api-config.sh none` | `VUS_LIST="10 50 100 200" DIST="hotset uniform" loadtest/run.sh` |

O `run.sh` faz uma execução para cada combinação de distribuição e número de clientes (aqui, 8).
Todas as leituras vão ao Mongo (`readsPerReadRequest` = 1). Esta é a capacidade de **API + banco**, a
referência para medir o ganho do cache.

### 11.2 Cache-aside e write-through sob carga

| Terminal da API | Terminal do gerador |
|---|---|
| `scripts/api-config.sh cache-aside` | `VUS_LIST="10 50 100 200" DIST="hotset uniform" loadtest/run.sh` |
| `scripts/api-config.sh write-through` | o mesmo comando |

O teste de leitura não faz escritas, então nele as duas estratégias usam **o mesmo código de
leitura**. Diferenças pequenas entre elas são ruído. A diferença entre elas aparece nas escritas
(11.4 a 11.6).

### 11.3 Cache frio (warm-up)

Mesma carga de 50 clientes, **sem aquecimento**: o cache começa vazio e as métricas contam desde a
primeira requisição. A pasta é outra para não substituir a execução aquecida nos gráficos.

| Terminal da API | Terminal do gerador |
|---|---|
| `scripts/api-config.sh cache-aside` | `RESULTS=results-aws-cold WARMUP_SECONDS=0 VUS_LIST=50 loadtest/run.sh` |

No relatório, compare o hit rate e o p95 com a execução `cache-aside-hotset-50vus` de
`results-aws/`.

### 11.4 Janela de desatualização

TTL curto (5 s). Um cliente sequencial escreve um produto e lê até a versão nova aparecer, 10 vezes
por configuração. Este cenário **altera produtos**; por isso fica depois dos testes de leitura.

| Terminal da API | Terminal do gerador |
|---|---|
| `scripts/api-config.sh cache-aside 5 true` | `SCRIPT=staleness ITERATIONS=10 loadtest/run.sh` |
| `scripts/api-config.sh cache-aside 5 false` | o mesmo comando |
| `scripts/api-config.sh write-through 5` | o mesmo comando |

Esperado:
- **cache-aside com invalidação:** janela 0 (o `DEL` faz a próxima leitura ser MISS);
- **cache-aside sem invalidação:** janela ≈ TTL e 100% das primeiras leituras velhas;
- **write-through:** janela 0 (o `SET` grava a versão nova e a próxima leitura é HIT).

### 11.5 Exemplo de invalidação (evidência legível)

O script `loadtest/invalidation-demo.sh` faz uma sequência curta no produto 42 e a salva em
`loadtest/results-aws/invalidation-<configuração>-<horário>.txt`:
1. esvazia o cache;
2. lê o produto duas vezes;
3. altera o preço (`PUT`);
4. lê de novo;
5. lê uma última vez.

Sem invalidação, a última leitura espera o TTL + 1 s, para mostrar o valor velho expirando.

| Terminal da API | Terminal do gerador |
|---|---|
| `scripts/api-config.sh cache-aside 10 false` | `loadtest/invalidation-demo.sh` |
| `scripts/api-config.sh cache-aside 10 true` | o mesmo comando |
| `scripts/api-config.sh write-through 10` | o mesmo comando |

Saída real, medida localmente, com cache-aside **sem** invalidação:

```
# strategy: cache-aside, ttl: 5 s, label: cache-aside-noinvalidate, product: 42, 2026-11-21 17:04:42 UTC
1. read                  X-Cache: MISS version 2
2. read                  X-Cache: HIT version 2
3. PUT (new price)       written to the database, version + 1
4. read right after      X-Cache: HIT version 2      <- versão antiga: dado desatualizado
5. read after 6 s        X-Cache: MISS version 3     <- o TTL expirou, a versão nova aparece
```

Na leitura 4: com invalidação aparece `MISS` com a versão nova (o `DEL` apagou a chave); no
write-through aparece `HIT` com a versão nova (o `SET` já gravou o valor novo).

### 11.6 Falha do cache no write-through (opcional)

Mostra o comportamento documentado em [caching-strategies.md](caching-strategies.md#partial-failure-mongodb-written-set-failed):
o banco é gravado, a resposta é 200 e o log registra a falha. Para simular o cache fora do ar, a API
é apontada para uma porta que o security group bloqueia. Tudo no **terminal da API**:

```bash
sed -i 's/^REDIS_PORT=.*/REDIS_PORT=6380/' .env      # porta errada = cache inalcançável
scripts/api-config.sh write-through
curl -s localhost:3000/health; echo                  # "degraded", redis down
curl -s -w ' [HTTP %{http_code}]\n' -X PUT localhost:3000/products/7 \
     -H 'content-type: application/json' -d '{"price": 12.5}'
docker compose -f compose.yaml logs api | grep write-through   # "cache SET failed ... DEL failed too ..."
sed -i 's/^REDIS_PORT=.*/REDIS_PORT=6379/' .env      # IMPORTANTE: volta a porta certa
scripts/api-config.sh write-through
```

Copie a saída para o relatório. As leituras nesse estado vêm do Mongo (`X-Cache: BYPASS`).

### 11.7 CloudWatch

> **Conceito: CloudWatch.** É o serviço de métricas da AWS. Ele coleta, sem configuração, números da
> infraestrutura: CPU das EC2 e, no ElastiCache, hits, misses, memória, conexões e rede. Ele dá a
> **visão da infraestrutura**; o k6 dá a visão do cliente e o `/metrics` a da aplicação.

Durante os cenários 11.1 e 11.2, abra:
- **ElastiCache → `tema10-cache` → Monitoring**: `CacheHitRate`, `CacheHits`/`CacheMisses`,
  `EngineCPUUtilization`, `CurrConnections`, `CurrItems`, `DatabaseMemoryUsagePercentage`,
  `Evictions` (deve ficar em 0), `NetworkBytesIn/Out` e `CPUCreditBalance` (nota do 8.2);
- **EC2 → `tema10-api` e `tema10-mongo` → Monitoring**: `CPUUtilization`.

No seletor de tempo, use o intervalo de cada estratégia (o nome dos arquivos tem o horário em UTC) e
**tire uma captura de tela por estratégia**. Os gráficos usam períodos de 1 min.

Duas leituras úteis para o relatório:
- O `CacheHitRate` do CloudWatch deve ser próximo do `hitRate` do `/metrics`: duas fontes
  independentes confirmando o mesmo número.
- CPU da API perto de **50%** (um núcleo cheio dos dois) indica que o limite é o Node, não o banco.
  Sem cache, a CPU do Mongo alta mostra o limite do banco: é assim que se diferencia o ganho do cache
  da capacidade do banco.

### 11.8 Cenário extra: efeito do TTL (opcional)

Para discutir a escolha do TTL, repita uma carga com TTLs diferentes, cada um na sua pasta:

| Terminal da API | Terminal do gerador |
|---|---|
| `scripts/api-config.sh cache-aside 5` | `RESULTS=results-aws-ttl5 VUS_LIST=50 DIST=uniform loadtest/run.sh` |
| `scripts/api-config.sh cache-aside 300` | `RESULTS=results-aws-ttl300 VUS_LIST=50 DIST=uniform loadtest/run.sh` |

---

## 12. Trazer os resultados e gerar os gráficos

Na **sua máquina**, na pasta do repositório, traga as pastas de resultados (o gerador será apagado no
passo 14):

```bash
LOADGEN=<IP público da tema10-loadgen>
for d in results-aws results-aws-cold; do
  rsync -av -e "ssh -i ~/.ssh/tema10-key.pem" \
    "ubuntu@$LOADGEN:products-cache-api/loadtest/$d/" "loadtest/$d/"
done
# no Windows (sem rsync): scp -i ~/.ssh/tema10-key.pem -r ubuntu@$LOADGEN:products-cache-api/loadtest/results-aws loadtest/

loadtest/plot.sh results-aws          # tabelas e gráficos em loadtest/results-aws/charts/
loadtest/plot.sh results-aws-cold
```

O `plot.sh` roda em Docker. Na primeira vez ele constrói a imagem (~30 s).

Saídas em `loadtest/results-aws/charts/`:
- `read-runs.csv` e `staleness-runs.csv`: uma linha por execução (os dados brutos consolidados);
- `latency-<dist>.png`, `throughput-<dist>.png`, `db-load-<dist>.png` e `hit-rate-<dist>.png`, com o
  número de clientes no eixo X e uma linha por estratégia;
- `staleness.png`: janela de desatualização por configuração, com a linha do TTL.

Os JSONs, o `ENVIRONMENT.md`, os `invalidation-*.txt` e os gráficos são as evidências do relatório.
Versione as pastas `loadtest/results-aws*` no Git: diferente de `loadtest/results/`, elas não são
ignoradas.

Se preferir, dá para rodar o `plot.sh` na própria EC2 do gerador (ela já tem Docker), **depois** das
medições. Você ainda precisa copiar os arquivos para a sua máquina, então isso não economiza passos.

---

## 13. Custos

Preços de referência sob demanda em `us-east-1`. Confira os valores atuais em
<https://aws.amazon.com/ec2/pricing/on-demand/> e <https://aws.amazon.com/elasticache/pricing/>.

| Recurso | Quantidade | US$/hora (aprox.) |
|---|---|---|
| EC2 `c7g.xlarge` (gerador) | 1 | 0,145 |
| EC2 `c7g.large` (API) | 1 | 0,073 |
| EC2 `m7g.medium` (Mongo) | 1 | 0,041 |
| ElastiCache `cache.t4g.micro` Valkey | 1 nó | 0,013 |
| IPv4 público | 3 | 0,015 |
| EBS gp3 20 GiB | 3 | 0,007 |
| CloudWatch (monitoramento detalhado) | 2–3 EC2 | ~0,01 |
| Tráfego entre máquinas | mesma AZ, IP privado | 0 |
| **Total** | | **~0,30/h** |

Uma sessão de 3 horas custa ~US$ 1. O custo real aparece em **Billing → Bills** ou **Cost Explorer**
em até 24 h. Use esse valor no relatório.

> **Conceito: cobrança por uso.** EC2 e ElastiCache cobram por hora (as EC2 por segundo) enquanto
> estão ligados. Uma EC2 **parada** (*Stop*) não cobra CPU, mas o disco EBS continua sendo cobrado. O
> ElastiCache **não pode ser parado**: só apagado. Recurso apagado para de cobrar.

Para a interpretação de trade-offs, uma conta útil é o custo por milhão de leituras:

```
custo por 1 milhão de leituras = (US$/hora da configuração) ÷ (leituras por segundo × 3600) × 1 000 000
```

Compare `none` (EC2 da API + Mongo) com `cache-aside` (o mesmo + o nó do cache), usando a vazão do
`read-runs.csv`. O cache custa ~US$ 0,013/h a mais. Se ele dobra a vazão, cada leitura sai mais
barata, e o banco recebe ~90% menos consultas: o banco poderia ser menor, ou atender mais clientes
com o mesmo tamanho.

---

## 14. Desmontar tudo

Faça **no mesmo dia** das medições, depois de conferir que os resultados estão na sua máquina
(passo 12).

1. **ElastiCache → Valkey caches → `tema10-cache` → Delete**. Em *Create final backup*, escolha
   **No**. Leva ~5–10 min.
2. **EC2 → Instances** → marque as três → *Instance state* → **Terminate**. Os discos EBS são
   apagados junto (*Delete on termination*, o padrão).
3. Quando o cache sumir da lista: **ElastiCache → Subnet groups → `tema10-cache-subnets` → Delete**.
4. **VPC → Your VPCs → `tema10-vpc` → Actions → Delete VPC**. Isso apaga junto as subnets, o Internet
   Gateway, as tabelas de rotas e os security groups.
5. Opcional: **EC2 → Key pairs → `tema10-key` → Delete** (é grátis, mas não é mais necessário).
6. No dia seguinte, confira em **Billing → Bills** que nada continua cobrando.

**Pausa entre dias, em vez de desmontar:**
- *Stop* nas EC2: param de cobrar CPU e IP, e o seed fica no disco;
- **apague o ElastiCache** e recrie no dia seguinte com o mesmo nome (passo 8.2): o endpoint
  costuma ser o mesmo, mas confira;
- ao religar as EC2, os IPs públicos mudam e os privados não.

---

## 15. Problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| `ssh` fica parado até dar *timeout* | Seu IP mudou, a EC2 não tem IP público, ou é a regra 22 errada | Edite a regra SSH do SG (*My IP* de novo); confira *Public IPv4 address* na instância |
| `Permission denied (publickey)` | Usuário ou chave errados | Usuário `ubuntu`; `-i ~/.ssh/tema10-key.pem`; `chmod 400` na chave |
| `permission denied ... docker.sock` | Grupo `docker` ainda não aplicado | Saia (`exit`) e entre de novo por SSH |
| A API não sobe; log com `MongoServerSelectionError` ou `Authentication failed` | IP privado errado, SG do Mongo sem a regra 27017 a partir de `tema10-api-sg`, ou senha diferente | Teste a rede na EC2 da API: `nc -zv <IP do Mongo> 27017`; confira `MONGODB_URI` no `.env` |
| `/health` mostra `"redis":"down"` (`degraded`) | `REDIS_TLS=false` com criptografia em trânsito ligada, endpoint com `:6379`, ou SG do cache sem a regra a partir de `tema10-api-sg` | Corrija o `.env` e rode `scripts/api-config.sh <estratégia>` de novo; teste a rede com `nc -zv <endpoint> 6379` |
| `run.sh`: `cannot reach the API at ...` | `API_URL` com IP público, ou SG da API sem a regra 3000 a partir de `tema10-loadgen-sg` | Use o IP privado da API |
| O `run.sh` não mostra a linha `settings: .../loadtest/aws.env` e usa `localhost` | O arquivo `loadtest/aws.env` não existe (ou foi criado em outra pasta) | Crie-o como no passo 10, dentro de `~/products-cache-api` |
| `run.sh` falha no `FLUSHDB` | SG do cache sem a regra a partir do gerador, ou `redis://` em vez de `rediss://` | Corrija a regra ou o `REDIS_URL`. `REDIS_URL=` (vazio) pula o flush, mas aí os resultados ficam contaminados pela execução anterior |
| `invalid configuration` nos logs da API | Valor inválido no `.env` | A mensagem diz qual variável; corrija e recrie |
| CPU do gerador perto de 100% (`top` num segundo terminal) | O k6 virou o gargalo | Use um tipo maior para o gerador e repita as execuções afetadas |
| `docker compose -f compose.yaml up` reclama de espaço | Disco de 8 GiB | *Modify volume* para 20 GiB no EBS e `sudo growpart /dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1`, ou recrie a EC2 |
